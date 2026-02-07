
import React, { useEffect, useRef } from 'react';

interface AudioVisualizerProps {
  analyser: AnalyserNode | null;
  outputAnalyser?: AnalyserNode | null;
  isActive: boolean;
  isUserSpeaking: boolean;
  isAISpeaking: boolean;
}

export const AudioVisualizer: React.FC<AudioVisualizerProps> = ({ 
  analyser, 
  outputAnalyser,
  isActive, 
  isUserSpeaking,
  isAISpeaking
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!isActive) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Use higher resolution for data arrays
    const bufferLength = analyser?.frequencyBinCount || 128;
    const inputData = new Uint8Array(bufferLength);
    const outputData = new Uint8Array(bufferLength);

    let animationFrameId: number;

    const render = () => {
      const width = canvas.width;
      const height = canvas.height;

      if (analyser) analyser.getByteFrequencyData(inputData);
      if (outputAnalyser) outputAnalyser.getByteFrequencyData(outputData);

      ctx.clearRect(0, 0, width, height);
      
      const barWidth = (width / bufferLength) * 1.5;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        // Blend or select based on who is speaking
        const inputVal = inputData[i] / 255;
        const outputVal = outputData[i] / 255;
        
        // Input Bars (User) - Blue
        if (inputVal > 0.05) {
          ctx.fillStyle = '#3B82F6';
          const h = (inputVal * height * 0.6) + 1;
          const y = (height - h) / 2;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(x, y, barWidth, h, barWidth/2);
          else ctx.rect(x, y, barWidth, h);
          ctx.fill();
        }

        // Output Bars (AI) - Purple (slightly offset for "depth")
        if (outputVal > 0.05) {
          ctx.fillStyle = 'rgba(168, 85, 247, 0.7)';
          const h = (outputVal * height * 0.5) + 1;
          const y = (height - h) / 2;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(x + 1, y, barWidth, h, barWidth/2);
          else ctx.rect(x + 1, y, barWidth, h);
          ctx.fill();
        }
        
        x += barWidth + 2;
      }

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [analyser, outputAnalyser, isActive, isUserSpeaking, isAISpeaking]);

  return (
    <div className="w-full flex items-center gap-3 px-3 h-10 bg-gray-950/60 rounded-full border border-white/5 backdrop-blur-md">
      {/* User Indicator */}
      <div className="shrink-0 flex items-center gap-1.5">
        <div className="relative flex items-center justify-center">
          <div className={`w-1.5 h-1.5 rounded-full transition-all duration-300 ${isUserSpeaking ? 'bg-blue-400 scale-125 shadow-[0_0_8px_rgba(59,130,246,0.6)]' : 'bg-gray-800'}`}></div>
          {isUserSpeaking && <div className="absolute w-3 h-3 border border-blue-400/30 rounded-full animate-ping"></div>}
        </div>
        <span className={`text-[8px] font-black uppercase tracking-widest ${isUserSpeaking ? 'text-blue-400' : 'text-gray-600'}`}>YOU</span>
      </div>

      {/* Shared Micro-Visualizer Canvas */}
      <div className="flex-1 h-5 relative overflow-hidden flex items-center px-1">
        <canvas 
          ref={canvasRef} 
          className={`w-full h-full transition-opacity duration-500 ${isActive ? 'opacity-100' : 'opacity-0'}`}
          width={240}
          height={20}
        />
      </div>

      {/* AI Indicator */}
      <div className="shrink-0 flex items-center gap-1.5">
        <span className={`text-[8px] font-black uppercase tracking-widest text-right ${isAISpeaking ? 'text-purple-400' : 'text-gray-600'}`}>AI</span>
        <div className="relative flex items-center justify-center">
          <div className={`w-1.5 h-1.5 rounded-full transition-all duration-300 ${isAISpeaking ? 'bg-purple-400 scale-125 shadow-[0_0_8px_rgba(168,85,247,0.6)]' : 'bg-gray-800'}`}></div>
          {isAISpeaking && <div className="absolute w-3 h-3 border border-purple-400/30 rounded-full animate-ping"></div>}
        </div>
      </div>
    </div>
  );
};
