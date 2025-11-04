import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, Modality, LiveSession } from "@google/genai";
import { decode, decodeAudioData, createBlob } from './utils/audio';
import { Loader } from './components/Loader';

// --- Configuration ---
const LANGUAGE_CONFIG = {
  "Hindi": { accents: ["North Indian", "South Indian", "Mumbai/Neutral"], defaultAccent: "Mumbai/Neutral" },
  "Bengali": { accents: ["Kolkata", "Sylheti"], defaultAccent: "Kolkata" },
  "Tamil": { accents: ["Chennai", "Madurai"], defaultAccent: "Chennai" },
  "Telugu": { accents: ["Coastal", "Telangana"], defaultAccent: "Coastal" },
  "Marathi": { accents: ["Pune", "Mumbai"], defaultAccent: "Pune" },
  "Kannada": { accents: ["Bengaluru", "Mysuru"], defaultAccent: "Bengaluru" },
  "English (India)": { accents: ["Neutral", "Indian English"], defaultAccent: "Indian English" },
};

const EMOTIONS = ["Neutral tone", "Happy tone", "Sad tone"];

type Language = keyof typeof LANGUAGE_CONFIG;

// --- Main Component ---
const App: React.FC = () => {
    const [messages, setMessages] = useState<{ sender: 'user' | 'ai', text: string }[]>([]);
    const [partialTranscript, setPartialTranscript] = useState<{ sender: 'user' | 'ai', text: string } | null>(null);
    const [isListening, setIsListening] = useState<boolean>(false);
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);
    const [statusMessage, setStatusMessage] = useState<string>('Click Start to begin conversation.');

    // --- User Selections ---
    const [selectedLanguage, setSelectedLanguage] = useState<Language>('Hindi');
    const [selectedAccent, setSelectedAccent] = useState<string>(LANGUAGE_CONFIG.Hindi.defaultAccent);
    const [selectedEmotion, setSelectedEmotion] = useState<string>(EMOTIONS[0]);

    // --- Web Audio & API Refs ---
    const sessionPromiseRef = useRef<Promise<LiveSession> | null>(null);
    const inputAudioContextRef = useRef<AudioContext | null>(null);
    const outputAudioContextRef = useRef<AudioContext | null>(null);
    const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
    const nextStartTimeRef = useRef<number>(0);
    const transcriptContainerRef = useRef<HTMLDivElement>(null);


    useEffect(() => {
        // Update accent when language changes
        const config = LANGUAGE_CONFIG[selectedLanguage];
        setSelectedAccent(config.defaultAccent);
    }, [selectedLanguage]);

    // Auto-scroll transcript view
    useEffect(() => {
        if (transcriptContainerRef.current) {
            transcriptContainerRef.current.scrollTop = transcriptContainerRef.current.scrollHeight;
        }
    }, [messages, partialTranscript]);

    const stopAudioPlayback = useCallback(() => {
        audioSourcesRef.current.forEach(source => {
            source.stop();
        });
        audioSourcesRef.current.clear();
        nextStartTimeRef.current = 0;
    }, []);

    const cleanup = useCallback(() => {
        setIsListening(false);
        setIsLoading(false);
        setPartialTranscript(null);

        stopAudioPlayback();

        if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach(track => track.stop());
            mediaStreamRef.current = null;
        }
        if (scriptProcessorRef.current) {
            scriptProcessorRef.current.disconnect();
            scriptProcessorRef.current = null;
        }
        if (inputAudioContextRef.current && inputAudioContextRef.current.state !== 'closed') {
            inputAudioContextRef.current.close().catch(console.error);
        }
        if (outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') {
            outputAudioContextRef.current.close().catch(console.error);
        }

        if (sessionPromiseRef.current) {
            sessionPromiseRef.current.then(session => session.close()).catch(console.error);
            sessionPromiseRef.current = null;
        }
    }, [stopAudioPlayback]);


    const handleToggleConversation = async () => {
        if (isListening || isLoading) {
            cleanup();
            setStatusMessage('Conversation stopped. Click Start to begin again.');
            return;
        }

        setIsLoading(true);
        setError(null);
        setMessages([]);
        setPartialTranscript(null);
        setStatusMessage('Requesting microphone access...');

        try {
            if (!process.env.API_KEY) {
                throw new Error("API_KEY is not set. Please configure it in your environment.");
            }
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaStreamRef.current = stream;

            inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

            let currentInputTranscription = '';
            let currentOutputTranscription = '';
            
            const systemInstruction = `You are an advanced Google AI voice agent.
- You MUST detect the user's spoken language from this list: ${Object.keys(LANGUAGE_CONFIG).join(', ')}.
- You MUST respond in the exact same language you detected.
- Your response MUST adopt the requested regional accent: "${selectedAccent}".
- Your response MUST have the requested emotional tone: "${selectedEmotion}".
- Your voice output must be clear, natural, and fluent with accurate pronunciation.
- Keep responses concise and conversational.`;


            setStatusMessage('Connecting to the voice agent...');
            sessionPromiseRef.current = ai.live.connect({
                model: 'gemini-2.5-flash-native-audio-preview-09-2025',
                config: {
                    responseModalities: [Modality.AUDIO],
                    systemInstruction,
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                },
                callbacks: {
                    onopen: () => {
                        setIsLoading(false);
                        setIsListening(true);
                        setStatusMessage('Connected. Listening...');
                        
                        const source = inputAudioContextRef.current!.createMediaStreamSource(stream);
                        scriptProcessorRef.current = inputAudioContextRef.current!.createScriptProcessor(4096, 1, 1);
                        
                        scriptProcessorRef.current.onaudioprocess = (audioProcessingEvent) => {
                            const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
                            const pcmBlob = createBlob(inputData);
                            sessionPromiseRef.current?.then((session) => {
                                session.sendRealtimeInput({ media: pcmBlob });
                            });
                        };
                        
                        source.connect(scriptProcessorRef.current);
                        scriptProcessorRef.current.connect(inputAudioContextRef.current!.destination);
                    },
                    onmessage: async (message) => {
                        if (message.serverContent?.inputTranscription) {
                            currentInputTranscription += message.serverContent.inputTranscription.text;
                            setPartialTranscript({ sender: 'user', text: currentInputTranscription });
                        }
                        if (message.serverContent?.outputTranscription) {
                            currentOutputTranscription += message.serverContent.outputTranscription.text;
                            setPartialTranscript({ sender: 'ai', text: currentOutputTranscription });
                        }

                        if (message.serverContent?.turnComplete) {
                           if(currentInputTranscription.trim()){
                             setMessages(prev => [...prev, { sender: 'user', text: currentInputTranscription.trim() }]);
                           }
                           if(currentOutputTranscription.trim()){
                             setMessages(prev => [...prev, { sender: 'ai', text: currentOutputTranscription.trim() }]);
                           }
                            currentInputTranscription = '';
                            currentOutputTranscription = '';
                            setPartialTranscript(null);
                        }
                        
                        if(message.serverContent?.interrupted){
                            stopAudioPlayback();
                        }

                        const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
                        if (audioData) {
                            const outputContext = outputAudioContextRef.current!;
                            nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputContext.currentTime);
                            
                            const decodedData = decode(audioData);
                            const audioBuffer = await decodeAudioData(decodedData, outputContext, 24000, 1);
                            
                            const source = outputContext.createBufferSource();
                            source.buffer = audioBuffer;
                            source.connect(outputContext.destination);
                            source.start(nextStartTimeRef.current);
                            
                            nextStartTimeRef.current += audioBuffer.duration;
                            audioSourcesRef.current.add(source);
                            source.onended = () => {
                                audioSourcesRef.current.delete(source);
                            };
                        }
                    },
                    onclose: () => {
                        cleanup();
                        setStatusMessage('Connection closed.');
                    },
                    onerror: (e) => {
                        console.error(e);
                        setError(`An error occurred: ${'message' in e ? e.message : 'Unknown error'}`);
                        cleanup();
                    },
                },
            });

        } catch (e: any) {
            console.error(e);
            setError(`Failed to start: ${e.message}`);
            cleanup();
        }
    };
    
    useEffect(() => {
      // Cleanup on component unmount
      return () => cleanup();
    }, [cleanup]);


    return (
        <div className="min-h-screen bg-gray-900 flex flex-col items-center justify-center p-4 font-sans text-white">
            <div className="w-full max-w-3xl mx-auto bg-gray-800 rounded-2xl shadow-2xl p-6 md:p-8 space-y-6">
                <header className="text-center">
                    <h1 className="text-3xl md:text-4xl font-bold text-cyan-400">Multilingual Voice AI Agent</h1>
                    <p className="text-gray-400 mt-2">Real-time voice conversation with accent and emotion control.</p>
                </header>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                        <label htmlFor="language-select" className="block text-sm font-medium text-gray-400 mb-1">Language</label>
                        <select id="language-select" value={selectedLanguage} onChange={e => setSelectedLanguage(e.target.value as Language)} disabled={isListening || isLoading} className="w-full p-2 bg-gray-700 border border-gray-600 rounded-md focus:ring-cyan-500 focus:border-cyan-500">
                            {Object.keys(LANGUAGE_CONFIG).map(lang => <option key={lang} value={lang}>{lang}</option>)}
                        </select>
                    </div>
                    <div>
                        <label htmlFor="accent-select" className="block text-sm font-medium text-gray-400 mb-1">Accent</label>
                        <select id="accent-select" value={selectedAccent} onChange={e => setSelectedAccent(e.target.value)} disabled={isListening || isLoading} className="w-full p-2 bg-gray-700 border border-gray-600 rounded-md focus:ring-cyan-500 focus:border-cyan-500">
                            {LANGUAGE_CONFIG[selectedLanguage].accents.map(acc => <option key={acc} value={acc}>{acc}</option>)}
                        </select>
                    </div>
                     <div>
                        <label htmlFor="emotion-select" className="block text-sm font-medium text-gray-400 mb-1">Emotion</label>
                        <select id="emotion-select" value={selectedEmotion} onChange={e => setSelectedEmotion(e.target.value)} disabled={isListening || isLoading} className="w-full p-2 bg-gray-700 border border-gray-600 rounded-md focus:ring-cyan-500 focus:border-cyan-500">
                            {EMOTIONS.map(emo => <option key={emo} value={emo}>{emo}</option>)}
                        </select>
                    </div>
                </div>

                <div className="text-center">
                     <button
                        onClick={handleToggleConversation}
                        className={`w-full flex items-center justify-center gap-3 font-bold py-3 px-4 rounded-lg transition duration-200 transform hover:scale-105 disabled:scale-100 ${
                            isListening ? 'bg-red-600 hover:bg-red-700' : 'bg-cyan-600 hover:bg-cyan-700'
                        }`}
                    >
                        {isLoading ? <Loader /> : (isListening ? 
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z" clipRule="evenodd" /></svg> : 
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" viewBox="0 0 20 20" fill="currentColor"><path d="M7 4a3 3 0 016 0v6a3 3 0 11-6 0V4z" /><path d="M5.5 8.5a.5.5 0 01.5-.5h8a.5.5 0 01.5.5v1a.5.5 0 01-.5.5h-8a.5.5 0 01-.5-.5v-1zM4 8a1 1 0 00-1 1v1a1 1 0 102 0V9a1 1 0 00-1-1zM15 8a1 1 0 00-1 1v1a1 1 0 102 0V9a1 1 0 00-1-1z" /></svg>
                        )}
                        <span>{isLoading ? 'Connecting...' : (isListening ? 'Stop Conversation' : 'Start Conversation')}</span>
                    </button>
                    <p className="text-gray-400 text-sm mt-2 h-5">{statusMessage}</p>
                </div>
                
                {error && (
                    <div className="bg-red-900/50 border border-red-700 text-red-300 px-4 py-3 rounded-lg" role="alert">
                        <strong className="font-bold">Error: </strong>
                        <span className="block sm:inline">{error}</span>
                    </div>
                )}

                <div ref={transcriptContainerRef} className="bg-gray-900/50 p-4 rounded-lg space-y-4 min-h-[200px] max-h-[40vh] overflow-y-auto">
                    {messages.length === 0 && !isListening && !isLoading && !partialTranscript && (
                        <p className="text-center text-gray-500">Conversation transcript will appear here.</p>
                    )}
                    {messages.map((msg, index) => (
                        <div key={index} className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                            <div className={`max-w-xs md:max-w-md lg:max-w-lg px-4 py-2 rounded-xl ${msg.sender === 'user' ? 'bg-cyan-800' : 'bg-gray-700'}`}>
                                <p className="text-white">{msg.text}</p>
                            </div>
                        </div>
                    ))}
                    {partialTranscript && (
                         <div className={`flex ${partialTranscript.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                            <div className={`max-w-xs md:max-w-md lg:max-w-lg px-4 py-2 rounded-xl ${partialTranscript.sender === 'user' ? 'bg-cyan-800' : 'bg-gray-700'}`}>
                                <p className="text-white/70 italic">{partialTranscript.text}</p>
                            </div>
                        </div>
                    )}
                </div>
            </div>
             <footer className="text-center text-gray-500 mt-8">
                <p>Powered by Google Gemini Live API</p>
            </footer>
        </div>
    );
};

export default App;
