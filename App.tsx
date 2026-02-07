
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { CallStatus, CallState, VoiceName, TranscriptionEntry } from './types';
import { decode, decodeAudioData, createBlob } from './utils/audioUtils';
import { AudioVisualizer } from './components/AudioVisualizer';

const MODEL_OPTIONS = [
  { id: 'gemini-2.5-flash-native-audio-preview-12-2025', label: 'Gemini 2.5 Flash (Native Audio)' },
  { id: 'gemini-2.5-flash-lite-latest', label: 'Gemini 2.5 Flash Lite' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (Alpha)' },
];

const LANGUAGES = [
  'Original', 'English', 'Spanish', 'French', 'German', 'Chinese', 'Japanese', 'Korean', 'Italian', 'Portuguese', 'Hindi', 'Arabic', 'Russian'
];

const App: React.FC = () => {
  const [state, setState] = useState<CallState>({
    status: CallStatus.IDLE,
    isMuted: false,
    isSpeakerOn: true,
    selectedVoice: 'Zephyr',
    selectedModel: 'gemini-2.5-flash-native-audio-preview-12-2025',
    targetLanguage: 'Original',
    transcriptions: [],
    isUserSpeaking: false,
  });

  const [isAISpeaking, setIsAISpeaking] = useState(false);
  const [isReaderMode, setIsReaderMode] = useState(true);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [typedText, setTypedText] = useState('');
  const [hasApiKey, setHasApiKey] = useState<boolean>(false);

  // Audio refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const inputNodeRef = useRef<GainNode | null>(null);
  const outputNodeRef = useRef<GainNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);

  const currentInputTranscription = useRef<string>('');
  const currentOutputTranscription = useRef<string>('');
  
  const vadHangoverRef = useRef<number>(0);
  const VAD_THRESHOLD = 0.012; 
  const VAD_HANGOVER_TIME = 400;

  useEffect(() => {
    const checkKeyStatus = async () => {
      const aistudio = (window as any).aistudio;
      if (aistudio && typeof aistudio.hasSelectedApiKey === 'function') {
        const selected = await aistudio.hasSelectedApiKey();
        setHasApiKey(selected);
      }
    };
    checkKeyStatus();
  }, []);

  const handleOpenKeySelector = async () => {
    const aistudio = (window as any).aistudio;
    if (aistudio && typeof aistudio.openSelectKey === 'function') {
      await aistudio.openSelectKey();
      setHasApiKey(true);
    }
  };

  useEffect(() => {
    if (transcriptScrollRef.current) {
      transcriptScrollRef.current.scrollTop = transcriptScrollRef.current.scrollHeight;
    }
  }, [state.transcriptions]);

  const handleStopCall = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => {
        try { track.stop(); } catch(e) {}
      });
      streamRef.current = null;
    }

    if (sessionRef.current) {
      const session = sessionRef.current;
      sessionRef.current = null;
      try { session.close(); } catch (e) {}
    }
    
    sourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) {}
    });
    sourcesRef.current.clear();
    setIsAISpeaking(false);

    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close().catch(() => {});
      inputAudioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close().catch(() => {});
      outputAudioContextRef.current = null;
    }

    setState(prev => ({ 
      ...prev, 
      status: CallStatus.IDLE, 
      isUserSpeaking: false 
    }));
    setIsKeyboardVisible(false);
  }, []);

  const handleStartCall = async () => {
    try {
      setState(prev => ({ ...prev, status: CallStatus.CONNECTING, error: undefined }));

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone access is not supported.');
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ 
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } 
        });
      } catch (mediaErr: any) {
        if (mediaErr.name === 'NotAllowedError') throw new Error('Microphone permission denied.');
        else throw new Error('No microphone detected.');
      }
      
      streamRef.current = stream;

      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const inCtx = new AudioContextClass({ sampleRate: 16000 });
      const outCtx = new AudioContextClass({ sampleRate: 24000 });
      
      await Promise.all([inCtx.resume(), outCtx.resume()]);
      
      inputAudioContextRef.current = inCtx;
      outputAudioContextRef.current = outCtx;

      const inGain = inCtx.createGain();
      const outGain = outCtx.createGain();
      inputNodeRef.current = inGain;
      outputNodeRef.current = outGain;
      
      const inAnalyser = inCtx.createAnalyser();
      inAnalyser.fftSize = 256;
      analyserRef.current = inAnalyser;

      const outAnalyser = outCtx.createAnalyser();
      outAnalyser.fftSize = 256;
      outputAnalyserRef.current = outAnalyser;

      const micSource = inCtx.createMediaStreamSource(stream);
      micSource.connect(inGain);
      inGain.connect(inAnalyser);

      outGain.connect(outAnalyser);
      outAnalyser.connect(outCtx.destination);

      if (!process.env.API_KEY) throw new Error('No API Key detected.');

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const translationInstruction = state.targetLanguage !== 'Original' 
        ? ` IMPORTANT: You must conduct the entire conversation in ${state.targetLanguage}. Translate everything you hear and say to ${state.targetLanguage}.`
        : "";

      const sessionPromise = ai.live.connect({
        model: state.selectedModel,
        callbacks: {
          onopen: () => {
            setState(prev => ({ ...prev, status: CallStatus.ACTIVE }));
            const scriptProcessor = inCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              if (!inputAudioContextRef.current || inputAudioContextRef.current.state === 'closed') return;
              const inputData = e.inputBuffer.getChannelData(0);
              let sum = 0;
              for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
              const rms = Math.sqrt(sum / inputData.length);
              
              if (rms > VAD_THRESHOLD && !state.isMuted) {
                vadHangoverRef.current = Date.now() + VAD_HANGOVER_TIME;
                setState(prev => prev.isUserSpeaking ? prev : { ...prev, isUserSpeaking: true });
              } else if (Date.now() > vadHangoverRef.current) {
                setState(prev => !prev.isUserSpeaking ? prev : { ...prev, isUserSpeaking: false });
              }

              if (state.isMuted || !sessionRef.current) return;
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(session => {
                if (sessionRef.current === session) session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            micSource.connect(scriptProcessor);
            scriptProcessor.connect(inCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              const currentOutCtx = outputAudioContextRef.current;
              const currentOutNode = outputNodeRef.current;
              if (currentOutCtx && currentOutNode && currentOutCtx.state !== 'closed') {
                nextStartTimeRef.current = Math.max(nextStartTimeRef.current, currentOutCtx.currentTime);
                const audioBuffer = await decodeAudioData(decode(base64Audio), currentOutCtx, 24000, 1);
                const source = currentOutCtx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(currentOutNode);
                
                source.addEventListener('ended', () => {
                  sourcesRef.current.delete(source);
                  setIsAISpeaking(sourcesRef.current.size > 0);
                });

                sourcesRef.current.add(source);
                setIsAISpeaking(true);
                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += audioBuffer.duration;
              }
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              sourcesRef.current.clear();
              setIsAISpeaking(false);
              nextStartTimeRef.current = 0;
            }

            if (message.serverContent?.inputTranscription) currentInputTranscription.current += message.serverContent.inputTranscription.text;
            if (message.serverContent?.outputTranscription) currentOutputTranscription.current += message.serverContent.outputTranscription.text;
            if (message.serverContent?.turnComplete) {
              const userText = currentInputTranscription.current;
              const aiText = currentOutputTranscription.current;
              const newEntries: TranscriptionEntry[] = [];
              if (userText) newEntries.push({ role: 'user', text: userText, timestamp: Date.now() });
              if (aiText) newEntries.push({ role: 'ai', text: aiText, timestamp: Date.now() });
              if (newEntries.length > 0) setState(prev => ({ ...prev, transcriptions: [...prev.transcriptions, ...newEntries] }));
              currentInputTranscription.current = '';
              currentOutputTranscription.current = '';
            }
          },
          onerror: (e: any) => {
            setState(prev => ({ ...prev, status: CallStatus.ERROR, error: e.message || "Connection Error" }));
            handleStopCall();
          },
          onclose: () => handleStopCall()
        },
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          inputAudioTranscription: {},
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: state.selectedVoice } } },
          systemInstruction: `Keep responses brief and natural. ${translationInstruction}`
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      setState(prev => ({ ...prev, status: CallStatus.ERROR, error: err.message }));
      handleStopCall();
    }
  };

  const handleSendTypedText = () => {
    const text = typedText.trim();
    if (!text || !sessionRef.current) return;
    const entry: TranscriptionEntry = { role: 'user', text, timestamp: Date.now() };
    setState(prev => ({ ...prev, transcriptions: [...prev.transcriptions, entry] }));
    try {
      if (typeof sessionRef.current.send === 'function') {
        sessionRef.current.send({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } });
      }
    } catch (e) {}
    setTypedText('');
  };

  const recentEntries = state.transcriptions.slice(-3);

  return (
    <div className="flex flex-col h-screen max-h-screen bg-black text-white p-4 pt-[calc(1rem+var(--safe-area-inset-top))] pb-[calc(1rem+var(--safe-area-inset-bottom))] font-sans select-none overflow-hidden">
      {/* Ultra-Minimal Header */}
      <div className="flex justify-between items-center h-10 shrink-0 px-2">
        <div className="flex flex-col">
          <h1 className="text-[10px] font-black text-gray-500 tracking-[0.3em] uppercase leading-none">Gemini Call</h1>
          {state.status === CallStatus.ACTIVE && (
            <span className="text-[7px] text-gray-700 font-bold uppercase mt-1">
              {MODEL_OPTIONS.find(m => m.id === state.selectedModel)?.label.replace('Gemini ', '')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {state.status === CallStatus.ACTIVE && state.targetLanguage !== 'Original' && (
            <div className="px-1.5 py-0.5 bg-blue-500/10 border border-blue-500/20 rounded">
              <span className="text-[8px] font-bold text-blue-500 uppercase tracking-widest">{state.targetLanguage}</span>
            </div>
          )}
          <span className={`text-[9px] font-black uppercase tracking-widest ${state.status === CallStatus.ACTIVE ? 'text-blue-500' : 'text-gray-700'}`}>
            {state.status}
          </span>
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        {state.status !== CallStatus.ACTIVE ? (
          <div className="h-full flex flex-col items-center justify-center space-y-8 overflow-y-auto custom-scrollbar px-4 pb-12">
            {state.status === CallStatus.CONNECTING ? (
              <div className="flex flex-col items-center gap-4">
                <div className="w-10 h-10 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
                <p className="text-[10px] text-blue-500 font-black tracking-widest uppercase">Connecting...</p>
              </div>
            ) : (
              <>
                <div className="w-20 h-20 bg-gray-950 rounded-[2rem] flex items-center justify-center border border-white/5 shadow-2xl">
                  <svg className="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                </div>
                
                <div className="w-full max-w-xs space-y-4">
                  <div className="bg-gray-900/40 p-5 rounded-[2.5rem] border border-white/5 space-y-4">
                    <div className="space-y-1.5">
                      <label className="text-[8px] font-black text-gray-600 uppercase tracking-[0.2em] ml-2">Authentication</label>
                      <button onClick={handleOpenKeySelector} className={`w-full p-3.5 rounded-3xl text-[10px] font-bold border transition-all ${hasApiKey ? 'bg-green-500/5 border-green-500/20 text-green-500' : 'bg-blue-600/5 border-blue-500/20 text-blue-500'}`}>
                        {hasApiKey ? '✓ Project Authenticated' : '+ Select API Key'}
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="text-[8px] font-black text-gray-600 uppercase tracking-[0.2em] ml-2">Voice</label>
                        <select 
                          value={state.selectedVoice}
                          onChange={(e) => setState(prev => ({ ...prev, selectedVoice: e.target.value as VoiceName }))}
                          className="w-full bg-black/60 border border-white/5 rounded-2xl p-3 text-[10px] outline-none appearance-none text-center"
                        >
                          {['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir'].map(v => <option key={v} value={v}>{v}</option>)}
                        </select>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[8px] font-black text-gray-600 uppercase tracking-[0.2em] ml-2">Language</label>
                        <select 
                          value={state.targetLanguage}
                          onChange={(e) => setState(prev => ({ ...prev, targetLanguage: e.target.value }))}
                          className="w-full bg-black/60 border border-white/5 rounded-2xl p-3 text-[10px] outline-none appearance-none text-center"
                        >
                          {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
                        </select>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-[8px] font-black text-gray-600 uppercase tracking-[0.2em] ml-2">Model Engine</label>
                      <select 
                        value={state.selectedModel}
                        onChange={(e) => setState(prev => ({ ...prev, selectedModel: e.target.value }))}
                        className="w-full bg-black/60 border border-white/5 rounded-2xl p-3 text-[10px] outline-none appearance-none text-center"
                      >
                        {MODEL_OPTIONS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                      </select>
                    </div>
                  </div>

                  <button onClick={handleStartCall} className="w-full bg-white text-black font-black py-4.5 rounded-[2.5rem] active:scale-95 transition-all shadow-xl tracking-tighter text-sm">
                    START SESSION
                  </button>
                </div>
              </>
            )}
            {state.status === CallStatus.ERROR && (
              <div className="p-4 bg-red-950/20 border border-red-500/30 rounded-3xl w-full max-w-xs text-center">
                <p className="text-red-400 text-[11px] font-bold leading-relaxed">{state.error}</p>
                <button onClick={() => setState(prev => ({ ...prev, status: CallStatus.IDLE }))} className="mt-3 text-[9px] font-black text-red-300 uppercase tracking-widest underline">Reset</button>
              </div>
            )}
          </div>
        ) : (
          <div className="h-full flex flex-col relative px-2">
            
            <div className={`flex-1 flex flex-col items-center justify-center p-6 transition-all duration-1000 ${isReaderMode ? 'opacity-100' : 'opacity-10 blur-xl scale-95'}`}>
               <div className="w-full h-full flex flex-col justify-center space-y-8">
                  {recentEntries.length > 0 ? (
                    recentEntries.map((entry, idx) => {
                      const isLatest = idx === recentEntries.length - 1;
                      return (
                        <p 
                          key={entry.timestamp + idx} 
                          className={`font-black leading-tight tracking-tighter transition-all duration-700 animate-in fade-in slide-in-from-bottom-4 ${
                            isLatest ? 'text-4xl sm:text-6xl text-white' : 'text-xl sm:text-2xl text-gray-900'
                          } ${entry.role === 'user' ? 'italic text-blue-600/60' : ''}`}
                        >
                          {entry.text}
                        </p>
                      );
                    })
                  ) : (
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-2 bg-gray-900 rounded-full animate-pulse"></div>
                      <div className="w-2 h-2 bg-gray-900 rounded-full animate-pulse [animation-delay:0.2s]"></div>
                      <div className="w-2 h-2 bg-gray-900 rounded-full animate-pulse [animation-delay:0.4s]"></div>
                    </div>
                  )}
               </div>
            </div>

            <div className="h-12 shrink-0 mb-4 px-2">
               <AudioVisualizer 
                analyser={analyserRef.current} 
                outputAnalyser={outputAnalyserRef.current}
                isActive={state.status === CallStatus.ACTIVE} 
                isUserSpeaking={state.isUserSpeaking}
                isAISpeaking={isAISpeaking}
               />
            </div>

            {!isReaderMode && (
              <div ref={transcriptScrollRef} className="absolute inset-x-0 top-0 bottom-24 z-10 overflow-y-auto p-6 space-y-4 bg-black/95 backdrop-blur-3xl animate-in fade-in zoom-in-95 duration-500 custom-scrollbar">
                {state.transcriptions.map((t, i) => (
                  <div key={i} className={`flex flex-col ${t.role === 'user' ? 'items-end' : 'items-start'}`}>
                    <div className={`max-w-[85%] rounded-[1.5rem] px-5 py-4 text-xs font-medium leading-relaxed ${t.role === 'user' ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-300 border border-white/5'}`}>{t.text}</div>
                  </div>
                ))}
              </div>
            )}

            <div className="h-20 shrink-0 grid grid-cols-4 items-center bg-gray-900/40 rounded-[2.5rem] border border-white/5 mb-2 px-3 shadow-2xl">
               <button onClick={() => setIsReaderMode(!isReaderMode)} className={`flex flex-col items-center gap-1.5 transition-colors ${isReaderMode ? 'text-blue-500' : 'text-gray-600'}`}>
                 <div className={`w-9 h-9 rounded-full flex items-center justify-center transition-all ${isReaderMode ? 'bg-blue-500/10' : 'bg-black/40'}`}>
                   <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 6h16M4 12h16M4 18h7" /></svg>
                 </div>
                 <span className="text-[8px] font-black uppercase tracking-widest">Reader</span>
               </button>
               
               <button onClick={() => setIsKeyboardVisible(!isKeyboardVisible)} className={`flex flex-col items-center gap-1.5 transition-colors ${isKeyboardVisible ? 'text-blue-500' : 'text-gray-600'}`}>
                 <div className={`w-9 h-9 rounded-full flex items-center justify-center transition-all ${isKeyboardVisible ? 'bg-blue-500/10' : 'bg-black/40'}`}>
                   <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" /></svg>
                 </div>
                 <span className="text-[8px] font-black uppercase tracking-widest">Input</span>
               </button>

               <button onClick={() => setState(p => ({ ...p, isMuted: !p.isMuted }))} className={`flex flex-col items-center gap-1.5 transition-colors ${state.isMuted ? 'text-red-500' : 'text-gray-600'}`}>
                 <div className={`w-9 h-9 rounded-full flex items-center justify-center transition-all ${state.isMuted ? 'bg-red-500/10' : 'bg-black/40'}`}>
                   <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                 </div>
                 <span className="text-[8px] font-black uppercase tracking-widest">{state.isMuted ? 'Unmute' : 'Mute'}</span>
               </button>

               <button onClick={handleStopCall} className="w-12 h-12 bg-red-600 rounded-full flex items-center justify-center mx-auto shadow-2xl active:scale-90 transition-all border-2 border-black/20">
                 <svg className="w-6 h-6 text-white rotate-[135deg]" fill="currentColor" viewBox="0 0 24 24"><path d="M6.62,10.79C8.06,13.62 10.38,15.94 13.21,17.38L15.41,15.18C15.69,14.9 16.08,14.82,16.43,14.93C17.55,15.3 18.75,15.5 20,15.5A1,1 0 0,1 21,16.5V20A1,1 0 0,1 20,21A17,17 0 0,1 3,4A1,1 0 0,1 4,3H7.5A1,1 0 0,1 8.5,4C8.5,5.25 8.7,6.45 9.07,7.57C9.18,7.92 9.1,8.31 8.82,8.59L6.62,10.79Z" /></svg>
               </button>
            </div>

            {isKeyboardVisible && (
              <div className="absolute bottom-24 inset-x-2 z-30 animate-in slide-in-from-bottom-4 duration-300">
                <div className="bg-gray-950/90 backdrop-blur-3xl border border-white/10 rounded-[2rem] p-2 flex gap-2 shadow-[0_20px_60px_rgba(0,0,0,0.8)]">
                  <input type="text" value={typedText} onChange={e => setTypedText(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSendTypedText()} placeholder="Type something..." className="flex-1 bg-transparent px-5 py-3 text-sm font-medium outline-none" autoFocus />
                  <button onClick={handleSendTypedText} className="bg-blue-600 text-white p-4 rounded-3xl active:scale-95 transition-all"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg></button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 3px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #222; border-radius: 10px; }
        @keyframes ping {
          75%, 100% {
            transform: scale(2);
            opacity: 0;
          }
        }
      `}</style>
    </div>
  );
};

export default App;
