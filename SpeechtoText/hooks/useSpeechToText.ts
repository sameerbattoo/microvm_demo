import { useState, useRef, useCallback, useEffect } from 'react';
import type { AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';

/**
 * Speech-to-Text Hook using Hugging Face Transformers
 * 
 * Security Note: This hook loads ML models in the browser which can consume significant resources.
 * - Model: Xenova/whisper-tiny.en (browser-optimized, ~40MB)
 * - Loading: User-initiated only, dynamically imported
 * - Resource Management: Single instance, proper cleanup on unmount
 */
// Type for pipeline function
type PipelineType = (
  task: string,
  model: string,
  options?: any
) => Promise<AutomaticSpeechRecognitionPipeline>;

// Dynamic import will be used at runtime
let pipeline: PipelineType | null = null;

export interface UseSpeechToTextOptions {
  model?: string;
  onTranscript?: (text: string) => void;
  onError?: (error: Error) => void;
  chunkDuration?: number; // Duration in seconds for each audio chunk
  silenceThreshold?: number; // RMS threshold below which is considered silence (0-1, default 0.01)
  silenceTimeout?: number; // Milliseconds of silence before auto-stopping (default 2000)
  onSilenceDetected?: () => void; // Called when silence auto-stop triggers
}

export interface UseSpeechToTextReturn {
  isListening: boolean;
  isLoading: boolean;
  isModelLoading: boolean;
  transcript: string;
  error: string | null;
  recordingDuration: number; // Duration in seconds
  startListening: () => Promise<void>;
  stopListening: () => void;
  resetTranscript: () => void;
  isSupported: boolean;
}

export const useSpeechToText = (options: UseSpeechToTextOptions = {}): UseSpeechToTextReturn => {
  const {
    model = 'Xenova/whisper-tiny.en',
    onTranscript,
    onError,
    chunkDuration = 5,
    silenceThreshold = 0.01,
    silenceTimeout = 2000,
    onSilenceDetected,
  } = options;

  const [isListening, setIsListening] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isModelLoading, setIsModelLoading] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [recordingDuration, setRecordingDuration] = useState(0);

  const transcriberRef = useRef<AutomaticSpeechRecognitionPipeline | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingStartTimeRef = useRef<number | null>(null);
  const durationIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const silenceStartRef = useRef<number | null>(null);
  const silenceCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const hasSpokenRef = useRef(false);

  // Check if browser supports required APIs
  const isSupported = typeof window !== 'undefined' && 
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    !!navigator.mediaDevices.getUserMedia &&
    typeof AudioContext !== 'undefined';

  // Initialize the Whisper model
  const initializeModel = useCallback(async () => {
    if (transcriberRef.current) return;

    try {
      setIsModelLoading(true);
      console.warn('⚠️ Loading ML model in browser - this may consume significant resources');
      setError(null);
      console.log('Loading Whisper model...');
      
      // Dynamically import transformers.js
      if (!pipeline) {
        const transformers = await import('@huggingface/transformers');
        pipeline = transformers.pipeline as PipelineType;
      }
      
      if (!pipeline) {
        throw new Error('Failed to load transformers.js');
      }
      
      transcriberRef.current = await pipeline(
        'automatic-speech-recognition',
        model,
        {
          // Use WebGPU if available, fallback to WASM
          device: 'webgpu',
        }
      );
      
      console.log('Whisper model loaded successfully');
    } catch (err) {
      console.error('Error loading model:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to load speech recognition model';
      setError(errorMessage);
      if (onError) onError(err instanceof Error ? err : new Error(errorMessage));
    } finally {
      setIsModelLoading(false);
    }
  }, [model, onError]);

  // Convert audio blob to the format required by Whisper
  const processAudioBlob = useCallback(async (blob: Blob): Promise<Float32Array> => {
    try {
      const arrayBuffer = await blob.arrayBuffer();
      
      // Create audio context with default sample rate first
      const audioContext = new AudioContext();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      
      // Get the audio data as Float32Array (mono)
      let audioData = audioBuffer.getChannelData(0);
      
      // Resample to 16kHz if needed
      if (audioBuffer.sampleRate !== 16000) {
        const ratio = audioBuffer.sampleRate / 16000;
        const newLength = Math.round(audioData.length / ratio);
        const result = new Float32Array(newLength);
        
        for (let i = 0; i < newLength; i++) {
          const srcIndex = Math.round(i * ratio);
          result[i] = audioData[srcIndex];
        }
        
        audioData = result;
      }
      
      // Close the audio context to free resources
      await audioContext.close();
      
      return audioData;
    } catch (err) {
      console.error('Error processing audio blob:', err);
      throw err;
    }
  }, []);

  // Transcribe audio chunk
  const transcribeChunk = useCallback(async (audioBlob: Blob) => {
    if (!transcriberRef.current) {
      console.error('Transcriber not initialized');
      return;
    }

    try {
      setIsLoading(true);
      console.log('Transcribing audio chunk...');
      
      const audioData = await processAudioBlob(audioBlob);
      
      const result = await transcriberRef.current(audioData, {
        return_timestamps: false,
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      
      const text = result.text.trim();
      console.log('Transcription result:', text);
      
      if (text) {
        setTranscript(prev => {
          const newTranscript = prev ? `${prev} ${text}` : text;
          if (onTranscript) onTranscript(newTranscript);
          return newTranscript;
        });
      }
    } catch (err) {
      console.error('Error transcribing audio:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to transcribe audio';
      setError(errorMessage);
      if (onError) onError(err instanceof Error ? err : new Error(errorMessage));
    } finally {
      setIsLoading(false);
    }
  }, [processAudioBlob, onTranscript, onError]);

  // Process accumulated audio chunks
  const processAccumulatedChunks = useCallback(async () => {
    if (audioChunksRef.current.length === 0) {
      console.log('No audio chunks to process');
      return;
    }

    console.log('Processing', audioChunksRef.current.length, 'audio chunks');
    
    const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
    const blobSize = audioBlob.size;
    console.log('Combined blob size:', blobSize, 'bytes');
    
    audioChunksRef.current = [];
    
    try {
      await transcribeChunk(audioBlob);
    } catch (err) {
      console.error('Error in processAccumulatedChunks:', err);
      setError(err instanceof Error ? err.message : 'Failed to process audio');
    }
  }, [transcribeChunk]);

  // Start listening
  const startListening = useCallback(async () => {
    if (!isSupported) {
      const errorMsg = 'Speech recognition is not supported in this browser';
      setError(errorMsg);
      if (onError) onError(new Error(errorMsg));
      return;
    }

    try {
      setError(null);
      
      // Initialize model if not already loaded
      if (!transcriberRef.current) {
        await initializeModel();
      }

      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        } 
      });
      
      streamRef.current = stream;

      // Create MediaRecorder with better audio settings
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType,
        audioBitsPerSecond: 128000,
      });
      
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          console.log('Audio chunk received:', event.data.size, 'bytes');
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        console.log('Recording stopped, processing all audio...');
        await processAccumulatedChunks();
      };

      // Start recording - capture everything, process on stop
      mediaRecorder.start();
      setIsListening(true);
      hasSpokenRef.current = false;

      // Set up silence detection using Web Audio API AnalyserNode
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      analyserRef.current = analyser;
      silenceStartRef.current = null;

      const dataArray = new Float32Array(analyser.fftSize);
      silenceCheckIntervalRef.current = setInterval(() => {
        if (!analyserRef.current) return;
        analyserRef.current.getFloatTimeDomainData(dataArray);
        // Calculate RMS
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i] * dataArray[i];
        }
        const rms = Math.sqrt(sum / dataArray.length);

        if (rms > silenceThreshold) {
          // User is speaking
          hasSpokenRef.current = true;
          silenceStartRef.current = null;
        } else if (hasSpokenRef.current) {
          // Silence detected after user has spoken
          if (!silenceStartRef.current) {
            silenceStartRef.current = Date.now();
          } else if (Date.now() - silenceStartRef.current >= silenceTimeout) {
            // Silence lasted long enough — auto-stop
            console.log('Silence detected, auto-stopping recording');
            if (onSilenceDetected) onSilenceDetected();
          }
        }
      }, 100);

      // Start duration tracking
      recordingStartTimeRef.current = Date.now();
      setRecordingDuration(0);
      
      durationIntervalRef.current = setInterval(() => {
        if (recordingStartTimeRef.current) {
          const elapsed = Math.floor((Date.now() - recordingStartTimeRef.current) / 1000);
          setRecordingDuration(elapsed);
        }
      }, 100); // Update every 100ms for smooth display

      console.log('Started recording');

    } catch (err) {
      console.error('Error starting speech recognition:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to start speech recognition';
      setError(errorMessage);
      if (onError) onError(err instanceof Error ? err : new Error(errorMessage));
    }
  }, [isSupported, initializeModel, processAccumulatedChunks, chunkDuration, onError]);

  // Stop listening
  const stopListening = useCallback(() => {
    console.log('Stopping recording...');
    
    // Clear duration tracking
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
    recordingStartTimeRef.current = null;
    
    // Clear silence detection
    if (silenceCheckIntervalRef.current) {
      clearInterval(silenceCheckIntervalRef.current);
      silenceCheckIntervalRef.current = null;
    }
    silenceStartRef.current = null;
    analyserRef.current = null;
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    setIsListening(false);
  }, []);

  // Reset transcript
  const resetTranscript = useCallback(() => {
    setTranscript('');
    setError(null);
    setRecordingDuration(0);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopListening();
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
      }
      if (silenceCheckIntervalRef.current) {
        clearInterval(silenceCheckIntervalRef.current);
      }
    };
  }, [stopListening]);

  return {
    isListening,
    isLoading,
    isModelLoading,
    transcript,
    error,
    recordingDuration,
    startListening,
    stopListening,
    resetTranscript,
    isSupported,
  };
};
