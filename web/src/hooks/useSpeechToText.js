/**
 * Speech-to-Text Hook using Hugging Face Transformers (Whisper)
 *
 * Runs the Whisper tiny.en model directly in the browser via WebGPU/WASM.
 * - Model: Xenova/whisper-tiny.en (~40MB, downloaded once and cached)
 * - Silence detection: auto-stops after 2s of silence
 * - Audio: resampled to 16kHz mono for Whisper
 */
import { useState, useRef, useCallback, useEffect } from 'react'

let pipelineFn = null

export function useSpeechToText(options = {}) {
  const {
    model = 'Xenova/whisper-tiny.en',
    onTranscript,
    silenceThreshold = 0.01,
    silenceTimeout = 2000,
    onSilenceDetected,
  } = options

  const [isListening, setIsListening] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [isModelLoading, setIsModelLoading] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [error, setError] = useState(null)
  const [recordingDuration, setRecordingDuration] = useState(0)

  const transcriberRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const audioChunksRef = useRef([])
  const streamRef = useRef(null)
  const startTimeRef = useRef(null)
  const durationIntervalRef = useRef(null)
  const analyserRef = useRef(null)
  const audioCtxRef = useRef(null)
  const silenceStartRef = useRef(null)
  const silenceIntervalRef = useRef(null)
  const hasSpokenRef = useRef(false)

  const isSupported = typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof AudioContext !== 'undefined'

  // Load Whisper model
  const initModel = useCallback(async () => {
    if (transcriberRef.current) return
    try {
      setIsModelLoading(true)
      setError(null)
      if (!pipelineFn) {
        const transformers = await import('@huggingface/transformers')
        pipelineFn = transformers.pipeline
      }
      transcriberRef.current = await pipelineFn(
        'automatic-speech-recognition',
        model,
        { device: 'webgpu' }
      )
    } catch (err) {
      // Fallback to WASM if WebGPU not available
      try {
        transcriberRef.current = await pipelineFn(
          'automatic-speech-recognition',
          model,
          { device: 'wasm' }
        )
      } catch (err2) {
        setError('Failed to load speech model: ' + (err2.message || err.message))
      }
    } finally {
      setIsModelLoading(false)
    }
  }, [model])

  // Process audio blob → Float32Array at 16kHz
  const processAudio = useCallback(async (blob) => {
    const arrayBuffer = await blob.arrayBuffer()
    const audioContext = new AudioContext()
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
    let audioData = audioBuffer.getChannelData(0)

    // Resample to 16kHz
    if (audioBuffer.sampleRate !== 16000) {
      const ratio = audioBuffer.sampleRate / 16000
      const newLen = Math.round(audioData.length / ratio)
      const resampled = new Float32Array(newLen)
      for (let i = 0; i < newLen; i++) {
        resampled[i] = audioData[Math.round(i * ratio)]
      }
      audioData = resampled
    }

    await audioContext.close()
    return audioData
  }, [])

  // Transcribe audio
  const transcribe = useCallback(async (blob) => {
    if (!transcriberRef.current) return
    try {
      setIsProcessing(true)
      const audioData = await processAudio(blob)
      const result = await transcriberRef.current(audioData, {
        return_timestamps: false,
        chunk_length_s: 30,
        stride_length_s: 5,
      })
      const text = result.text.trim()
      if (text) {
        setTranscript(text)
        if (onTranscript) onTranscript(text)
      }
    } catch (err) {
      setError('Transcription failed: ' + err.message)
    } finally {
      setIsProcessing(false)
    }
  }, [processAudio, onTranscript])

  // Start recording
  const startListening = useCallback(async () => {
    if (!isSupported) {
      setError('Speech recognition not supported in this browser')
      return
    }
    try {
      setError(null)
      setTranscript('')

      if (!transcriberRef.current) await initModel()

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true }
      })
      streamRef.current = stream

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm'
      const recorder = new MediaRecorder(stream, { mimeType })
      mediaRecorderRef.current = recorder
      audioChunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        if (audioChunksRef.current.length > 0) {
          const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
          audioChunksRef.current = []
          await transcribe(blob)
        }
      }

      recorder.start()
      setIsListening(true)
      hasSpokenRef.current = false

      // Silence detection via AnalyserNode
      const audioCtx = new AudioContext()
      audioCtxRef.current = audioCtx
      const source = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 2048
      source.connect(analyser)
      analyserRef.current = analyser
      silenceStartRef.current = null

      const dataArr = new Float32Array(analyser.fftSize)
      silenceIntervalRef.current = setInterval(() => {
        if (!analyserRef.current) return
        analyserRef.current.getFloatTimeDomainData(dataArr)
        let sum = 0
        for (let i = 0; i < dataArr.length; i++) sum += dataArr[i] * dataArr[i]
        const rms = Math.sqrt(sum / dataArr.length)

        if (rms > silenceThreshold) {
          hasSpokenRef.current = true
          silenceStartRef.current = null
        } else if (hasSpokenRef.current) {
          if (!silenceStartRef.current) {
            silenceStartRef.current = Date.now()
          } else if (Date.now() - silenceStartRef.current >= silenceTimeout) {
            if (onSilenceDetected) onSilenceDetected()
          }
        }
      }, 100)

      // Duration tracker
      startTimeRef.current = Date.now()
      setRecordingDuration(0)
      durationIntervalRef.current = setInterval(() => {
        if (startTimeRef.current) {
          setRecordingDuration(Math.floor((Date.now() - startTimeRef.current) / 1000))
        }
      }, 200)

    } catch (err) {
      setError('Mic access denied: ' + err.message)
    }
  }, [isSupported, initModel, transcribe, silenceThreshold, silenceTimeout, onSilenceDetected])

  // Stop recording
  const stopListening = useCallback(() => {
    if (durationIntervalRef.current) { clearInterval(durationIntervalRef.current); durationIntervalRef.current = null }
    if (silenceIntervalRef.current) { clearInterval(silenceIntervalRef.current); silenceIntervalRef.current = null }
    silenceStartRef.current = null
    analyserRef.current = null
    if (audioCtxRef.current) { audioCtxRef.current.close().catch(() => {}); audioCtxRef.current = null }
    if (mediaRecorderRef.current?.state !== 'inactive') mediaRecorderRef.current?.stop()
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null }
    setIsListening(false)
  }, [])

  const resetTranscript = useCallback(() => { setTranscript(''); setError(null) }, [])

  // Cleanup on unmount
  useEffect(() => () => { stopListening() }, [stopListening])

  return {
    isListening,
    isProcessing,
    isModelLoading,
    transcript,
    error,
    recordingDuration,
    startListening,
    stopListening,
    resetTranscript,
    isSupported,
  }
}
