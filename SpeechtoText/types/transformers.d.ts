// Type declarations for @huggingface/transformers
declare module '@huggingface/transformers' {
  export interface PipelineOptions {
    device?: string;
    dtype?: string;
  }

  export interface TranscriptionResult {
    text: string;
    chunks?: Array<{
      text: string;
      timestamp: [number, number];
    }>;
  }

  export interface TranscriptionOptions {
    return_timestamps?: boolean;
    chunk_length_s?: number;
    stride_length_s?: number;
  }

  export interface AutomaticSpeechRecognitionPipeline {
    (
      audio: Float32Array | string,
      options?: TranscriptionOptions
    ): Promise<TranscriptionResult>;
  }

  export function pipeline(
    task: 'automatic-speech-recognition',
    model: string,
    options?: PipelineOptions
  ): Promise<AutomaticSpeechRecognitionPipeline>;

  export function pipeline(
    task: string,
    model: string,
    options?: PipelineOptions
  ): Promise<any>;

  export const env: {
    localModelPath: string;
    allowRemoteModels: boolean;
    backends: {
      onnx: {
        wasm: {
          numThreads: number;
        };
      };
    };
  };
}
