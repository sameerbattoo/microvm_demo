import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  Box,
  Paper,
  TextField,
  IconButton,
  Typography,
  CircularProgress,
  Alert,
  useTheme,
  alpha,
  Button,
  Tooltip,
  Menu,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Autocomplete,
} from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import PersonIcon from '@mui/icons-material/Person';
import RefreshIcon from '@mui/icons-material/Refresh';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import LightbulbIcon from '@mui/icons-material/Lightbulb';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import MicIcon from '@mui/icons-material/Mic';
import { useTheme as useAppTheme } from '../contexts/ThemeContext';
import { Customer } from '../types';
import { authService } from '../services/authService';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { marked } from 'marked';
import { useSpeechToText } from '../hooks/useSpeechToText';
import { AudioWaveform } from './AudioWaveform';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  isStreaming?: boolean;
  thinking?: string[];
  toolUse?: string[];
}

const SESSION_STORAGE_KEY = 'insightmate_session_id';
const LAST_INTERACTION_KEY = 'insightmate_last_interaction';
const SESSION_TIMEOUT_MS = 40 * 60 * 1000; // 40 minutes in milliseconds

// Helper function to get a unique icon for each customer based on their name
const getCustomerIcon = (customerName: string): string => {
  const icons = ['🏢', '🏭', '🏪', '🏬', '🏛️', '🏗️', '🏘️', '🏚️', '🏙️', '🌆', '🌇', '🏰', '🏯', '🏟️', '⛪', '🕌', '🛕', '🕍', '⛩️', '🗼'];
  const hash = customerName.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return icons[hash % icons.length];
};

interface InsightMateProps {
  customers: Customer[];
  userTeams: string[];
}

export const InsightMate: React.FC<InsightMateProps> = ({ customers, userTeams }) => {
  const theme = useTheme();
  const { mode } = useAppTheme();
  const [messages, setMessages] = useState<Message[]>(() => {
    // Try to restore messages from localStorage
    try {
      const savedMessages = localStorage.getItem('insightmate_messages');
      if (savedMessages) {
        const parsed = JSON.parse(savedMessages);
        // Convert timestamp strings back to Date objects
        return parsed.map((msg: any) => ({
          ...msg,
          timestamp: new Date(msg.timestamp),
        }));
      }
    } catch (error) {
      console.error('Error loading messages from localStorage:', error);
    }
    return [];
  });
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState(() => {
    // Check if session has expired based on last interaction time
    const lastInteractionStr = localStorage.getItem(LAST_INTERACTION_KEY);
    const existingSessionId = localStorage.getItem(SESSION_STORAGE_KEY);
    
    if (existingSessionId && lastInteractionStr) {
      const lastInteraction = new Date(lastInteractionStr);
      const now = new Date();
      const timeSinceLastInteraction = now.getTime() - lastInteraction.getTime();
      
      if (timeSinceLastInteraction < SESSION_TIMEOUT_MS) {
        // Session is still valid
        console.log('Resuming existing session:', existingSessionId);
        console.log(`Last interaction: ${Math.floor(timeSinceLastInteraction / 1000 / 60)} minutes ago`);
        return existingSessionId;
      } else {
        // Session expired, clear old data
        console.log('Session expired (>40 minutes of inactivity), creating new session');
        localStorage.removeItem(SESSION_STORAGE_KEY);
        localStorage.removeItem(LAST_INTERACTION_KEY);
        localStorage.removeItem('insightmate_messages');
      }
    }
    
    // Generate new session ID and store it
    const newSessionId = crypto.randomUUID();
    localStorage.setItem(SESSION_STORAGE_KEY, newSessionId);
    localStorage.setItem(LAST_INTERACTION_KEY, new Date().toISOString());
    console.log('Created new session:', newSessionId);
    return newSessionId;
  });
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [exportAnchorEl, setExportAnchorEl] = useState<null | HTMLElement>(null);
  const exportMenuOpen = Boolean(exportAnchorEl);
  const [debugDialogOpen, setDebugDialogOpen] = useState(false);
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [meetingCustomer, setMeetingCustomer] = useState<Customer | null>(null);
  const [activityCustomer, setActivityCustomer] = useState<Customer | null>(null);

  // Auto-hide header/input for immersive chat reading
  const [chromeHidden, setChromeHidden] = useState(false);
  const chatAreaRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const chatArea = chatAreaRef.current;
    if (!chatArea) return;

    const EDGE_ZONE = 60; // px from top/bottom edge to reveal

    const handleMouseMove = (e: MouseEvent) => {
      const rect = chatArea.getBoundingClientRect();
      const relY = e.clientY - rect.top;
      const nearTop = relY < EDGE_ZONE;
      const nearBottom = relY > rect.height - EDGE_ZONE;

      if (nearTop || nearBottom) {
        if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
        setChromeHidden(false);
      } else if (!chromeHidden) {
        if (!hideTimerRef.current) {
          hideTimerRef.current = setTimeout(() => { setChromeHidden(true); hideTimerRef.current = null; }, 800);
        }
      }
    };

    const handleMouseLeave = () => {
      if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
      setChromeHidden(false);
    };

    chatArea.addEventListener('mousemove', handleMouseMove);
    chatArea.addEventListener('mouseleave', handleMouseLeave);
    return () => {
      chatArea.removeEventListener('mousemove', handleMouseMove);
      chatArea.removeEventListener('mouseleave', handleMouseLeave);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [chromeHidden]);

  // Track whether we're waiting for transcription after silence auto-stop
  const [pendingAutoSubmit, setPendingAutoSubmit] = useState(false);
  
  // Queue for messages sent while agent is busy
  const queuedMessageRef = useRef<string | null>(null);
  const isLoadingRef = useRef(false);

  // Speech-to-text hook
  const {
    isListening,
    isLoading: isSpeechLoading,
    isModelLoading,
    transcript: speechTranscript,
    error: speechError,
    recordingDuration,
    startListening,
    stopListening,
    resetTranscript,
    isSupported: isSpeechSupported,
  } = useSpeechToText({
    model: 'Xenova/whisper-tiny.en',
    chunkDuration: 5,
    silenceThreshold: 0.01,
    silenceTimeout: 2000,
    onSilenceDetected: () => {
      // Auto-stop recording when silence is detected
      stopListening();
      setPendingAutoSubmit(true);
    },
  });

  // Auto-submit speech transcript when recording stops (silence or manual)
  useEffect(() => {
    if (speechTranscript && pendingAutoSubmit && !isLoading) {
      setPendingAutoSubmit(false);
      const text = speechTranscript.trim();
      resetTranscript();
      if (text) {
        sendMessageWithText(text);
      }
    }
  }, [speechTranscript, pendingAutoSubmit]);

  // Save messages to localStorage whenever they change
  useEffect(() => {
    if (messages.length > 0) {
      localStorage.setItem('insightmate_messages', JSON.stringify(messages));
    }
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const startNewConversation = () => {
    // Generate new session ID
    const newSessionId = crypto.randomUUID();
    localStorage.setItem(SESSION_STORAGE_KEY, newSessionId);
    localStorage.setItem(LAST_INTERACTION_KEY, new Date().toISOString());
    console.log('Started new conversation:', newSessionId);
    
    // Clear messages from localStorage
    localStorage.removeItem('insightmate_messages');
    
    // Clear messages and reset state
    setMessages([]);
    setError(null);
    setSessionId(newSessionId);
    setMeetingCustomer(null);
    setActivityCustomer(null);
    
    // No need to reload - just reset the state
  };

  const handleExportClick = (event: React.MouseEvent<HTMLElement>) => {
    setExportAnchorEl(event.currentTarget);
  };

  const handleExportClose = () => {
    setExportAnchorEl(null);
  };

  const handleExport = (format: 'md' | 'csv' | 'html' | 'json') => {
    handleExportClose();
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `insightmate-chat-${timestamp}`;
    
    if (format === 'md') {
      exportToMarkdown(filename);
    } else if (format === 'csv') {
      exportToCsv(filename);
    } else if (format === 'html') {
      exportToHtml(filename);
    } else if (format === 'json') {
      exportToJson(filename);
    }
  };

  const exportToMarkdown = (filename: string) => {
    let markdown = '# InsightMate Chat Export\n\n';
    markdown += `Generated: ${new Date().toLocaleString()}\n`;
    markdown += `Session ID: ${sessionId}\n\n`;
    markdown += '---\n\n';
    
    messages.forEach((msg, idx) => {
      markdown += `## ${msg.role === 'user' ? 'User' : 'Assistant'} (${msg.timestamp.toLocaleString()})\n\n`;
      markdown += `${msg.content}\n\n`;
      if (idx < messages.length - 1) {
        markdown += '---\n\n';
      }
    });
    
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportToCsv = (filename: string) => {
    const headers = ['Timestamp', 'Role', 'Message'];
    const rows = messages.map(msg => [
      msg.timestamp.toLocaleString(),
      msg.role === 'user' ? 'User' : 'Assistant',
      `"${msg.content.replace(/"/g, '""')}"` // Escape quotes
    ]);
    
    const csv = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportToHtml = (filename: string) => {
    // Configure marked for GFM (tables, strikethrough, etc.)
    marked.setOptions({ gfm: true, breaks: true });

    let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>InsightMate Chat Export</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; color: #1f2937; }
    h1 { color: #667eea; }
    .metadata { color: #666; font-size: 14px; margin-bottom: 30px; }
    .message { margin-bottom: 20px; padding: 15px; border-radius: 8px; overflow-wrap: break-word; }
    .user { background: #667eea; color: white; margin-left: 20%; }
    .user a { color: #c7d2fe; }
    .assistant { background: #f3f4f6; color: #1f2937; margin-right: 20%; }
    .assistant a { color: #4f46e5; }
    .role { font-weight: 600; margin-bottom: 5px; }
    .timestamp { font-size: 12px; opacity: 0.7; margin-top: 5px; }
    .content { line-height: 1.6; }
    .content h1, .content h2, .content h3, .content h4 { margin-top: 1em; margin-bottom: 0.5em; }
    .content p { margin: 0.5em 0; }
    .content ul, .content ol { margin: 0.5em 0; padding-left: 1.5em; }
    .content li { margin: 0.25em 0; }
    .content table { border-collapse: collapse; width: 100%; margin: 0.75em 0; font-size: 14px; }
    .content th, .content td { border: 1px solid #d1d5db; padding: 8px 12px; text-align: left; }
    .content th { background: rgba(0,0,0,0.06); font-weight: 600; }
    .content code { background: rgba(0,0,0,0.06); padding: 2px 5px; border-radius: 3px; font-size: 0.9em; }
    .content pre { background: #1e293b; color: #e2e8f0; padding: 12px; border-radius: 6px; overflow-x: auto; }
    .content pre code { background: none; padding: 0; color: inherit; }
    .content hr { border: none; border-top: 1px solid #d1d5db; margin: 1em 0; }
    .content blockquote { border-left: 3px solid #667eea; margin: 0.5em 0; padding: 0.5em 1em; background: rgba(102,126,234,0.05); }
    .content strong { font-weight: 600; }
  </style>
</head>
<body>
  <h1>InsightMate Chat Export</h1>
  <div class="metadata">
    <div>Generated: ${new Date().toLocaleString()}</div>
    <div>Session ID: ${sessionId}</div>
  </div>
`;
    
    messages.forEach(msg => {
      const roleClass = msg.role === 'user' ? 'user' : 'assistant';
      const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
      const renderedContent = marked.parse(preprocessMarkdown(msg.content)) as string;
      html += `
  <div class="message ${roleClass}">
    <div class="role">${roleLabel}</div>
    <div class="content">${renderedContent}</div>
    <div class="timestamp">${msg.timestamp.toLocaleString()}</div>
  </div>
`;
    });
    
    html += `
</body>
</html>`;
    
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportToJson = (filename: string) => {
    const data = {
      exported: new Date().toISOString(),
      sessionId: sessionId,
      messageCount: messages.length,
      messages: messages.map(msg => ({
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp.toISOString(),
      })),
    };
    
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Accessible customers for the meeting dropdown
  const accessibleCustomers = useMemo(() => {
    return customers
      .filter(c => c.AWS_Team && userTeams.includes(c.AWS_Team))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [customers, userTeams]);

  // Generate dynamic sample questions based on user's territories
  const sampleQuestions = useMemo(() => {
    // Find territory with most companies
    const territoryCounts = customers.reduce((acc, customer) => {
      const territory = customer.AWS_Team || '';
      if (territory && userTeams.includes(territory)) {
        acc[territory] = (acc[territory] || 0) + 1;
      }
      return acc;
    }, {} as Record<string, number>);
    
    const topTerritory = Object.entries(territoryCounts)
      .sort(([, a], [, b]) => b - a)[0]?.[0];
    
    return {
      topTerritory: topTerritory || '',
    };
  }, [customers, userTeams, accessibleCustomers]);

  // Check for pre-filled prompt from AI Insights prompt hooks
  useEffect(() => {
    const handler = () => {
      const prefillPrompt = sessionStorage.getItem('insightmate_prefill_prompt');
      if (prefillPrompt) {
        sessionStorage.removeItem('insightmate_prefill_prompt');
        sessionStorage.removeItem('insightmate_force_new_session');
        setTimeout(() => sendMessageWithText(prefillPrompt), 300);
      }
    };
    window.addEventListener('insightmate-prefill', handler);
    return () => window.removeEventListener('insightmate-prefill', handler);
  }, []);

  const sendMessage = async () => {
    if (!input.trim()) return;
    
    const text = input.trim();
    setInput('');
    resetTranscript();
    await sendMessageWithText(text);
  };

  const handleMicClick = async () => {
    if (isListening) {
      stopListening();
      setPendingAutoSubmit(true);
    } else {
      resetTranscript();
      setInput('');
      setPendingAutoSubmit(false);
      await startListening();
    }
  };

  const sendMessageWithText = async (text: string) => {
    if (!text) return;

    // If agent is busy, queue the message and show a waiting indicator
    if (isLoadingRef.current) {
      queuedMessageRef.current = text;
      const queuedUserMsg: Message = {
        id: 'queued-user-' + crypto.randomUUID(),
        role: 'user',
        content: text,
        timestamp: new Date(),
      };
      const queuedAssistantMsg: Message = {
        id: 'queued-assistant',
        role: 'assistant',
        content: '⏳ Waiting for the current response to finish...',
        timestamp: new Date(),
        isStreaming: false,
      };
      setMessages(prev => [...prev, queuedUserMsg, queuedAssistantMsg]);
      return;
    }

    // Check if session has expired before sending message
    const lastInteractionStr = localStorage.getItem(LAST_INTERACTION_KEY);
    if (lastInteractionStr) {
      const lastInteraction = new Date(lastInteractionStr);
      const now = new Date();
      const timeSinceLastInteraction = now.getTime() - lastInteraction.getTime();
      
      if (timeSinceLastInteraction >= SESSION_TIMEOUT_MS) {
        // Session expired, generate new session ID
        const newSessionId = crypto.randomUUID();
        setSessionId(newSessionId);
        localStorage.setItem(SESSION_STORAGE_KEY, newSessionId);
        console.log('Session expired, generated new session:', newSessionId);
        
        // Clear old messages since we're starting a new session
        setMessages([]);
        localStorage.removeItem('insightmate_messages');
      }
    }

    // Update last interaction timestamp
    const now = new Date();
    localStorage.setItem(LAST_INTERACTION_KEY, now.toISOString());
    console.log('Updated last interaction time:', now.toISOString());

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setIsLoading(true);
    isLoadingRef.current = true;
    setError(null);

    // Create assistant message placeholder
    const assistantMessageId = crypto.randomUUID();
    const assistantMessage: Message = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      isStreaming: true,
      thinking: [],
      toolUse: [],
    };

    setMessages(prev => [...prev, assistantMessage]);

    try {
      // Get access token from auth service (in memory)
      const accessToken = await authService.getAccessToken();
      
      if (!accessToken) {
        throw new Error('No access token available');
      }
      
      // Call AgentCore directly (bypass API Gateway)
      const agentArn = import.meta.env.VITE_AGENT_ARN;
      const region = import.meta.env.VITE_AWS_REGION || 'us-west-2';
      const encodedArn = encodeURIComponent(agentArn);
      
      const url = `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodedArn}/invocations?qualifier=DEFAULT`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
        },
        body: JSON.stringify({
          user_input: userMessage.content,
        }),
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error('SESSION_EXPIRED');
        }
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            let data = line.slice(6).trim();
            
            // Remove surrounding quotes and unescape
            if (data.startsWith('"') && data.endsWith('"')) {
              try {
                data = JSON.parse(data);
              } catch {
                data = data.slice(1, -1);
              }
            }

            if (data) {
              const dataStripped = data.replace(/^\r?\n/, '');
              
              if (dataStripped.startsWith('[TOOL USE]')) {
                // Capture tool use data
                const toolUseText = dataStripped.replace('[TOOL USE]', '');
                console.log('Captured TOOL USE:', toolUseText);
                setMessages(prev => prev.map(msg => 
                  msg.id === assistantMessageId
                    ? { ...msg, toolUse: [...(msg.toolUse || []), toolUseText] }
                    : msg
                ));
                continue;
              } else if (dataStripped.startsWith('[THINKING]')) {
                // Capture thinking data
                const thinkingText = dataStripped.replace('[THINKING]', '');
                console.log('Captured THINKING:', thinkingText);
                setMessages(prev => prev.map(msg => 
                  msg.id === assistantMessageId
                    ? { ...msg, thinking: [...(msg.thinking || []), thinkingText] }
                    : msg
                ));
                continue;
              } else {
                setMessages(prev => prev.map(msg => 
                  msg.id === assistantMessageId
                    ? { ...msg, content: msg.content + data }
                    : msg
                ));
              }
            }
          }
        }
      }

      // Mark streaming as complete
      setMessages(prev => prev.map(msg => 
        msg.id === assistantMessageId
          ? { ...msg, isStreaming: false }
          : msg
      ));

    } catch (err) {
      console.error('Error sending message:', err);
      const errorMessage = err instanceof Error && err.message === 'SESSION_EXPIRED'
        ? 'Your InsightMate session has expired. Please click "New Chat" above to start a fresh session.'
        : (err instanceof Error ? err.message : 'Failed to send message');
      setError(errorMessage);
      // Mark streaming as complete even on error (don't leave hanging indicator)
      setMessages(prev => prev.map(msg => 
        msg.id === assistantMessageId
          ? { ...msg, isStreaming: false }
          : msg
      ));
      // Only remove the message if it has no content (complete failure)
      setMessages(prev => {
        const msg = prev.find(m => m.id === assistantMessageId);
        if (msg && !msg.content) {
          return prev.filter(m => m.id !== assistantMessageId);
        }
        return prev;
      });
    } finally {
      setIsLoading(false);
      isLoadingRef.current = false;
      
      // Check for queued message and auto-send it
      const queued = queuedMessageRef.current;
      if (queued) {
        queuedMessageRef.current = null;
        // Remove the waiting placeholder AND the queued user message
        setMessages(prev => prev.filter(m => m.id !== 'queued-assistant' && !m.id.startsWith('queued-user-')));
        // Small delay to let state settle
        setTimeout(() => sendMessageWithText(queued), 200);
      }
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // Format recording duration as MM:SS
  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Preprocess markdown to fix hashtag formatting
  const preprocessMarkdown = (content: string): string => {
    // Simple aggressive fix: merge any consecutive lines that are just code blocks with hashtags
    let processed = content;
    
    // Pattern: lines with just `#word` possibly with commas
    // Replace: `#word`\n`#word` with `#word`, `#word`
    processed = processed.replace(/(`#\w+`)\s*\n\s*(`#\w+`)/g, '$1, $2');
    
    // Run multiple times to catch all
    for (let i = 0; i < 20; i++) {
      const before = processed;
      processed = processed.replace(/(`#\w+`)\s*\n\s*(`#\w+`)/g, '$1, $2');
      if (before === processed) break;
    }
    
    // Remove lines that are just commas
    processed = processed.replace(/^\s*,\s*$/gm, '');
    
    // Remove multiple consecutive newlines
    processed = processed.replace(/\n{3,}/g, '\n\n');
    
    return processed;
  };

  // Custom markdown components for styling
  const markdownComponents: Components = {
    p: ({ children }) => (
      <Typography 
        variant="body2" 
        component="div" 
        sx={{ 
          mb: 1.5, 
          lineHeight: 1.6,
          '&:last-child': { mb: 0 },
        }}
      >
        {children}
      </Typography>
    ),
    h1: ({ children }) => (
      <Typography variant="h5" sx={{ fontWeight: 600, mb: 2, mt: 2 }}>
        {children}
      </Typography>
    ),
    h2: ({ children }) => (
      <Typography variant="h6" sx={{ fontWeight: 600, mb: 1.5, mt: 1.5 }}>
        {children}
      </Typography>
    ),
    h3: ({ children }) => (
      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1, mt: 1 }}>
        {children}
      </Typography>
    ),
    ul: ({ children }) => (
      <Box component="ul" sx={{ pl: 2, mb: 1 }}>
        {children}
      </Box>
    ),
    ol: ({ children }) => (
      <Box component="ol" sx={{ pl: 2, mb: 1 }}>
        {children}
      </Box>
    ),
    li: ({ children }) => (
      <Box 
        component="li" 
        sx={{ 
          mb: 0.5,
          display: 'flex',
          alignItems: 'baseline',
          '& > p': {
            display: 'inline',
            mb: 0,
          },
          '& > p:not(:last-child)': {
            mr: 0.5,
          },
          '& code': {
            display: 'inline',
            whiteSpace: 'nowrap',
          },
        }}
      >
        <Typography variant="body2" component="span" sx={{ lineHeight: 1.6, display: 'inline' }}>
          {children}
        </Typography>
      </Box>
    ),
    code: ({ inline, children, ...props }: any) => {
      if (inline) {
        return (
          <Box
            component="code"
            sx={{
              display: 'inline',
              backgroundColor: alpha(theme.palette.primary.main, 0.1),
              padding: '2px 6px',
              borderRadius: '4px',
              fontFamily: 'monospace',
              fontSize: '0.875em',
              whiteSpace: 'nowrap',
            }}
            {...props}
          >
            {children}
          </Box>
        );
      }
      return (
        <Box
          component="pre"
          sx={{
            backgroundColor: alpha(theme.palette.primary.main, 0.05),
            padding: 2,
            borderRadius: 1,
            overflow: 'auto',
            mb: 2,
          }}
        >
          <Box
            component="code"
            sx={{
              fontFamily: 'monospace',
              fontSize: '0.875rem',
            }}
            {...props}
          >
            {children}
          </Box>
        </Box>
      );
    },
    table: ({ children }) => (
      <TableContainer component={Paper} sx={{ mb: 2, maxWidth: '100%' }}>
        <Table size="small">{children}</Table>
      </TableContainer>
    ),
    thead: ({ children }) => <TableHead>{children}</TableHead>,
    tbody: ({ children }) => <TableBody>{children}</TableBody>,
    tr: ({ children }) => <TableRow>{children}</TableRow>,
    th: ({ children }) => (
      <TableCell sx={{ fontWeight: 600 }}>{children}</TableCell>
    ),
    td: ({ children }) => <TableCell>{children}</TableCell>,
    blockquote: ({ children }) => (
      <Box
        sx={{
          borderLeft: 4,
          borderColor: 'primary.main',
          pl: 2,
          py: 0.5,
          mb: 2,
          fontStyle: 'italic',
          color: 'text.secondary',
        }}
      >
        {children}
      </Box>
    ),
    a: ({ href, children }) => (
      <Box
        component="a"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        sx={{
          color: 'primary.main',
          textDecoration: 'none',
          '&:hover': {
            textDecoration: 'underline',
          },
        }}
      >
        {children}
      </Box>
    ),
  };

  return (
    <Box sx={{ height: 'calc(100vh - 140px)', display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}>
      {/* Header */}
      <Paper
        elevation={0}
        sx={{
          p: 1.5,
          borderBottom: 1,
          borderColor: 'divider',
          backgroundColor: theme.palette.mode === 'dark' 
            ? alpha(theme.palette.primary.main, 0.1)
            : alpha(theme.palette.primary.main, 0.05),
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          flexShrink: 0,
          transition: 'transform 0.35s ease, opacity 0.35s ease',
          ...(chromeHidden && {
            transform: 'translateY(-100%)',
            opacity: 0,
            pointerEvents: 'none',
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 10,
          }),
          ...(!chromeHidden && {
            position: 'relative',
            zIndex: 10,
          }),
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <LightbulbIcon 
              sx={{ 
                fontSize: 40, 
                color: isLoading 
                  ? '#10b981' // Green when thinking
                  : 'primary.main',
                fontWeight: isLoading ? 700 : 400,
                transition: 'all 0.3s ease',
                animation: isLoading ? 'thinkingPulse 1.5s ease-in-out infinite' : 'none',
                '@keyframes thinkingPulse': {
                  '0%, 100%': {
                    opacity: 1,
                    transform: 'scale(1)',
                  },
                  '50%': {
                    opacity: 0.7,
                    transform: 'scale(1.1)',
                  },
                },
              }} 
            />
            <Tooltip title={`Session ID: ${sessionId}`} placement="bottom-start">
              <Box>
                <Typography variant="h6" sx={{ fontWeight: 600 }}>
                  InsightMate
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Your AI-powered customer intelligence assistant
                </Typography>
              </Box>
            </Tooltip>
          </Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Tooltip title="Export chat history">
              <Button
                variant="outlined"
                size="small"
                startIcon={<FileDownloadIcon />}
                onClick={handleExportClick}
                disabled={isLoading || messages.length === 0}
                sx={{ textTransform: 'none' }}
              >
                Export
              </Button>
            </Tooltip>
            <Tooltip title="Start a new conversation (clears history)">
              <Button
                variant="outlined"
                size="small"
                startIcon={<RefreshIcon />}
                onClick={startNewConversation}
                disabled={isLoading}
                sx={{ textTransform: 'none' }}
              >
                New Chat
              </Button>
            </Tooltip>
          </Box>
        </Box>
        <Menu
          anchorEl={exportAnchorEl}
          open={exportMenuOpen}
          onClose={handleExportClose}
        >
          <MenuItem onClick={() => handleExport('md')}>Export as Markdown (.md)</MenuItem>
          <MenuItem onClick={() => handleExport('csv')}>Export as CSV (.csv)</MenuItem>
          <MenuItem onClick={() => handleExport('json')}>Export as JSON (.json)</MenuItem>
          <MenuItem onClick={() => handleExport('html')}>Export as HTML (.html)</MenuItem>
        </Menu>
      </Paper>

      {/* Messages Area */}
      <Box
        ref={chatAreaRef}
        sx={{
          flex: 1,
          overflowY: 'auto',
          p: 2,
          backgroundColor: theme.palette.mode === 'dark'
            ? theme.palette.background.default
            : theme.palette.grey[50],
          minHeight: 0, // Important for flex scrolling
        }}
      >
        {messages.length === 0 && (
          <Box
            sx={{
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 3,
            }}
          >
            <LightbulbIcon sx={{ fontSize: 80, color: 'text.disabled' }} />
            <Typography variant="h6" color="text.secondary" align="center">
              Welcome to InsightMate!
            </Typography>
            <Typography variant="body2" color="text.secondary" align="center" sx={{ maxWidth: 500 }}>
              Ask me anything about your customers, their activities, or analytics.
              I can help you discover insights, track trends, and answer questions about your territory.
            </Typography>
            <Box sx={{ 
              display: 'grid', 
              gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, 
              gap: 2, 
              maxWidth: 800, 
              width: '100%',
              px: 2,
            }}>
              {/* Card 1: Meeting question with customer dropdown */}
              <Paper
                elevation={0}
                sx={{
                  p: 2.5,
                  borderRadius: 2,
                  border: '1px solid',
                  cursor: meetingCustomer ? 'pointer' : 'default',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 1.5,
                  background: mode === 'light'
                    ? 'linear-gradient(135deg, rgba(102, 126, 234, 0.08) 0%, rgba(118, 75, 162, 0.08) 100%)'
                    : mode === 'dark'
                    ? 'linear-gradient(135deg, rgba(129, 140, 248, 0.12) 0%, rgba(192, 132, 252, 0.12) 100%)'
                    : 'linear-gradient(135deg, rgba(255, 107, 53, 0.12) 0%, rgba(255, 140, 66, 0.12) 100%)',
                  borderColor: mode === 'light'
                    ? 'rgba(102, 126, 234, 0.25)'
                    : mode === 'dark'
                    ? 'rgba(129, 140, 248, 0.25)'
                    : 'rgba(255, 107, 53, 0.25)',
                  transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                  animation: 'fadeInUp 0.5s ease-out 0s both',
                  '@keyframes fadeInUp': {
                    from: { opacity: 0, transform: 'translateY(20px)' },
                    to: { opacity: 1, transform: 'translateY(0)' },
                  },
                  '&:hover': {
                    borderColor: mode === 'light'
                      ? 'rgba(102, 126, 234, 0.5)'
                      : mode === 'dark'
                      ? 'rgba(129, 140, 248, 0.5)'
                      : 'rgba(255, 107, 53, 0.5)',
                    transform: meetingCustomer ? 'translateY(-2px)' : 'none',
                    boxShadow: meetingCustomer
                      ? mode === 'light'
                        ? '0 8px 16px rgba(102, 126, 234, 0.15)'
                        : mode === 'dark'
                        ? '0 8px 16px rgba(129, 140, 248, 0.2)'
                        : '0 8px 16px rgba(255, 107, 53, 0.2)'
                      : 'none',
                  },
                }}
                onClick={() => {
                  if (meetingCustomer && !isLoading) {
                    sendMessageWithText(`I have an upcoming meeting with ${meetingCustomer.name}, give me the key talking points`);
                  }
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <LightbulbIcon sx={{ fontSize: 20, color: 'primary.main' }} />
                  <Typography variant="body2" sx={{ fontWeight: 500, lineHeight: 1.5 }}>
                    I have an upcoming meeting with ... , give me the key talking points
                  </Typography>
                </Box>
                <Autocomplete
                  size="small"
                  options={accessibleCustomers}
                  getOptionLabel={(option) => option.name}
                  value={meetingCustomer}
                  onChange={(_, newValue) => setMeetingCustomer(newValue)}
                  onClick={(e: React.MouseEvent) => e.stopPropagation()}
                  renderOption={(props, option) => (
                    <li {...props} key={option.id}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                        {option.logo_url ? (
                          <Box
                            component="img"
                            src={option.logo_url}
                            alt={option.name}
                            sx={{ width: 24, height: 24, objectFit: 'contain', borderRadius: '4px' }}
                          />
                        ) : (
                          <Box component="span" sx={{ fontSize: '1.2em', lineHeight: 1 }}>
                            {getCustomerIcon(option.name)}
                          </Box>
                        )}
                        <Typography variant="body2" sx={{ fontSize: '0.85rem' }}>{option.name}</Typography>
                      </Box>
                    </li>
                  )}
                  renderInput={(params) => (
                    <TextField {...params} placeholder="Select a customer" variant="outlined" size="small" />
                  )}
                  componentsProps={{
                    paper: {
                      sx: {
                        bgcolor: mode === 'light' ? '#ffffff' : mode === 'dark' ? '#1e293b' : '#2a2a2a',
                        backgroundImage: 'none !important',
                        border: '1px solid',
                        borderColor: 'divider',
                        boxShadow: 3,
                      },
                    },
                    popper: {
                      sx: { zIndex: 1500 },
                    },
                  }}
                  sx={{ 
                    '& .MuiOutlinedInput-root': { fontSize: '0.85rem' },
                  }}
                />
              </Paper>

              {/* Card 2: Activity trends for territory */}
              {sampleQuestions.topTerritory && (
                <Paper
                  elevation={0}
                  onClick={async () => {
                    if (!isLoading) {
                      await sendMessageWithText(`Visualize the last 30 days activity trends for the territory ${sampleQuestions.topTerritory}`);
                    }
                  }}
                  sx={{
                    p: 2.5,
                    borderRadius: 2,
                    border: '1px solid',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    background: mode === 'light'
                      ? 'linear-gradient(135deg, rgba(102, 126, 234, 0.08) 0%, rgba(118, 75, 162, 0.08) 100%)'
                      : mode === 'dark'
                      ? 'linear-gradient(135deg, rgba(129, 140, 248, 0.12) 0%, rgba(192, 132, 252, 0.12) 100%)'
                      : 'linear-gradient(135deg, rgba(255, 107, 53, 0.12) 0%, rgba(255, 140, 66, 0.12) 100%)',
                    borderColor: mode === 'light'
                      ? 'rgba(102, 126, 234, 0.25)'
                      : mode === 'dark'
                      ? 'rgba(129, 140, 248, 0.25)'
                      : 'rgba(255, 107, 53, 0.25)',
                    transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                    animation: 'fadeInUp 0.5s ease-out 0.1s both',
                    '&:hover': {
                      borderColor: mode === 'light'
                        ? 'rgba(102, 126, 234, 0.5)'
                        : mode === 'dark'
                        ? 'rgba(129, 140, 248, 0.5)'
                        : 'rgba(255, 107, 53, 0.5)',
                      transform: 'translateY(-2px)',
                      boxShadow: mode === 'light'
                        ? '0 8px 16px rgba(102, 126, 234, 0.15)'
                        : mode === 'dark'
                        ? '0 8px 16px rgba(129, 140, 248, 0.2)'
                        : '0 8px 16px rgba(255, 107, 53, 0.2)',
                    },
                  }}
                >
                  <LightbulbIcon sx={{ fontSize: 20, color: 'primary.main', flexShrink: 0 }} />
                  <Typography variant="body2" sx={{ fontWeight: 500, lineHeight: 1.5 }}>
                    Visualize the last 30 days activity trends for the territory {sampleQuestions.topTerritory}
                  </Typography>
                </Paper>
              )}

              {/* Card 3: Social media activities with customer dropdown */}
              <Paper
                elevation={0}
                sx={{
                  p: 2.5,
                  borderRadius: 2,
                  border: '1px solid',
                  cursor: activityCustomer ? 'pointer' : 'default',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 1.5,
                  background: mode === 'light'
                    ? 'linear-gradient(135deg, rgba(102, 126, 234, 0.08) 0%, rgba(118, 75, 162, 0.08) 100%)'
                    : mode === 'dark'
                    ? 'linear-gradient(135deg, rgba(129, 140, 248, 0.12) 0%, rgba(192, 132, 252, 0.12) 100%)'
                    : 'linear-gradient(135deg, rgba(255, 107, 53, 0.12) 0%, rgba(255, 140, 66, 0.12) 100%)',
                  borderColor: mode === 'light'
                    ? 'rgba(102, 126, 234, 0.25)'
                    : mode === 'dark'
                    ? 'rgba(129, 140, 248, 0.25)'
                    : 'rgba(255, 107, 53, 0.25)',
                  transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                  animation: 'fadeInUp 0.5s ease-out 0.2s both',
                  '&:hover': {
                    borderColor: mode === 'light'
                      ? 'rgba(102, 126, 234, 0.5)'
                      : mode === 'dark'
                      ? 'rgba(129, 140, 248, 0.5)'
                      : 'rgba(255, 107, 53, 0.5)',
                    transform: activityCustomer ? 'translateY(-2px)' : 'none',
                    boxShadow: activityCustomer
                      ? mode === 'light'
                        ? '0 8px 16px rgba(102, 126, 234, 0.15)'
                        : mode === 'dark'
                        ? '0 8px 16px rgba(129, 140, 248, 0.2)'
                        : '0 8px 16px rgba(255, 107, 53, 0.2)'
                      : 'none',
                  },
                }}
                onClick={() => {
                  if (activityCustomer && !isLoading) {
                    sendMessageWithText(`Visualize the last 30 days social media activities for the customer ${activityCustomer.name}`);
                  }
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <LightbulbIcon sx={{ fontSize: 20, color: 'primary.main' }} />
                  <Typography variant="body2" sx={{ fontWeight: 500, lineHeight: 1.5 }}>
                    Visualize the last 30 days social media activities for the customer ...
                  </Typography>
                </Box>
                <Autocomplete
                  size="small"
                  options={accessibleCustomers}
                  getOptionLabel={(option) => option.name}
                  value={activityCustomer}
                  onChange={(_, newValue) => setActivityCustomer(newValue)}
                  onClick={(e: React.MouseEvent) => e.stopPropagation()}
                  renderOption={(props, option) => (
                    <li {...props} key={option.id}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                        {option.logo_url ? (
                          <Box
                            component="img"
                            src={option.logo_url}
                            alt={option.name}
                            sx={{ width: 24, height: 24, objectFit: 'contain', borderRadius: '4px' }}
                          />
                        ) : (
                          <Box component="span" sx={{ fontSize: '1.2em', lineHeight: 1 }}>
                            {getCustomerIcon(option.name)}
                          </Box>
                        )}
                        <Typography variant="body2" sx={{ fontSize: '0.85rem' }}>{option.name}</Typography>
                      </Box>
                    </li>
                  )}
                  renderInput={(params) => (
                    <TextField {...params} placeholder="Select a customer" variant="outlined" size="small" />
                  )}
                  componentsProps={{
                    paper: {
                      sx: {
                        bgcolor: mode === 'light' ? '#ffffff' : mode === 'dark' ? '#1e293b' : '#2a2a2a',
                        backgroundImage: 'none !important',
                        border: '1px solid',
                        borderColor: 'divider',
                        boxShadow: 3,
                      },
                    },
                    popper: {
                      sx: { zIndex: 1500 },
                    },
                  }}
                  sx={{ 
                    '& .MuiOutlinedInput-root': { fontSize: '0.85rem' },
                  }}
                />
              </Paper>

              {/* Card 4: Activity heatmap for territory */}
              {sampleQuestions.topTerritory && (
                <Paper
                  elevation={0}
                  onClick={async () => {
                    if (!isLoading) {
                      await sendMessageWithText(`Visualize the last 30 days activity heatmap for the territory ${sampleQuestions.topTerritory}`);
                    }
                  }}
                  sx={{
                    p: 2.5,
                    borderRadius: 2,
                    border: '1px solid',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    background: mode === 'light'
                      ? 'linear-gradient(135deg, rgba(102, 126, 234, 0.08) 0%, rgba(118, 75, 162, 0.08) 100%)'
                      : mode === 'dark'
                      ? 'linear-gradient(135deg, rgba(129, 140, 248, 0.12) 0%, rgba(192, 132, 252, 0.12) 100%)'
                      : 'linear-gradient(135deg, rgba(255, 107, 53, 0.12) 0%, rgba(255, 140, 66, 0.12) 100%)',
                    borderColor: mode === 'light'
                      ? 'rgba(102, 126, 234, 0.25)'
                      : mode === 'dark'
                      ? 'rgba(129, 140, 248, 0.25)'
                      : 'rgba(255, 107, 53, 0.25)',
                    transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                    animation: 'fadeInUp 0.5s ease-out 0.3s both',
                    '&:hover': {
                      borderColor: mode === 'light'
                        ? 'rgba(102, 126, 234, 0.5)'
                        : mode === 'dark'
                        ? 'rgba(129, 140, 248, 0.5)'
                        : 'rgba(255, 107, 53, 0.5)',
                      transform: 'translateY(-2px)',
                      boxShadow: mode === 'light'
                        ? '0 8px 16px rgba(102, 126, 234, 0.15)'
                        : mode === 'dark'
                        ? '0 8px 16px rgba(129, 140, 248, 0.2)'
                        : '0 8px 16px rgba(255, 107, 53, 0.2)',
                    },
                  }}
                >
                  <LightbulbIcon sx={{ fontSize: 20, color: 'primary.main', flexShrink: 0 }} />
                  <Typography variant="body2" sx={{ fontWeight: 500, lineHeight: 1.5 }}>
                    Visualize the last 30 days activity heatmap for the territory {sampleQuestions.topTerritory}
                  </Typography>
                </Paper>
              )}
            </Box>
          </Box>
        )}

        {messages.map((message) => (
          <Box
            key={message.id}
            sx={{
              display: 'flex',
              justifyContent: message.role === 'user' ? 'flex-end' : 'flex-start',
              mb: 2,
              animation: 'fadeIn 0.3s ease-in',
              '@keyframes fadeIn': {
                from: { opacity: 0, transform: 'translateY(10px)' },
                to: { opacity: 1, transform: 'translateY(0)' }
              }
            }}
          >
            <Box
              sx={{
                maxWidth: '70%',
                display: 'flex',
                flexDirection: message.role === 'user' ? 'row-reverse' : 'row',
                gap: 1,
                alignItems: 'flex-start',
              }}
            >
              {/* Avatar */}
              <Box
                sx={{
                  width: 40,
                  height: 40,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: message.role === 'user'
                    ? mode === 'light'
                      ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
                      : mode === 'dark'
                      ? 'linear-gradient(135deg, #818cf8 0%, #c084fc 100%)'
                      : 'linear-gradient(135deg, #ff6b35 0%, #ff8c42 100%)'
                    : mode === 'light'
                      ? 'linear-gradient(135deg, #764ba2 0%, #667eea 100%)'
                      : mode === 'dark'
                      ? 'linear-gradient(135deg, #c084fc 0%, #818cf8 100%)'
                      : 'linear-gradient(135deg, #ff8c42 0%, #ff6b35 100%)',
                  color: 'white',
                  flexShrink: 0,
                  boxShadow: mode === 'light'
                    ? '0 4px 12px rgba(102, 126, 234, 0.3)'
                    : mode === 'dark'
                    ? '0 4px 12px rgba(129, 140, 248, 0.4)'
                    : '0 4px 12px rgba(255, 107, 53, 0.4)',
                  animation: message.isStreaming ? 'pulse 2s ease-in-out infinite' : 'none',
                  '@keyframes pulse': {
                    '0%, 100%': {
                      boxShadow: mode === 'light'
                        ? '0 4px 12px rgba(102, 126, 234, 0.3)'
                        : mode === 'dark'
                        ? '0 4px 12px rgba(129, 140, 248, 0.4)'
                        : '0 4px 12px rgba(255, 107, 53, 0.4)',
                    },
                    '50%': {
                      boxShadow: mode === 'light'
                        ? '0 4px 20px rgba(102, 126, 234, 0.6)'
                        : mode === 'dark'
                        ? '0 4px 20px rgba(129, 140, 248, 0.7)'
                        : '0 4px 20px rgba(255, 107, 53, 0.7)',
                    },
                  },
                }}
              >
                {message.role === 'user' ? <PersonIcon /> : <SmartToyIcon />}
              </Box>

              {/* Message Content */}
              <Box sx={{ flex: 1 }}>
                {/* Main Message */}
                <Paper
                  elevation={1}
                  sx={{
                    p: 2,
                    backgroundColor: message.role === 'user'
                      ? theme.palette.primary.main
                      : theme.palette.background.paper,
                    color: message.role === 'user'
                      ? '#ffffff'
                      : theme.palette.text.primary,
                    borderRadius: 2,
                    transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                    border: '1px solid',
                    borderColor: message.role === 'user'
                      ? 'transparent'
                      : 'divider',
                    '&:hover': {
                      transform: 'translateY(-4px)',
                      boxShadow: message.role === 'user'
                        ? mode === 'light'
                          ? '0 12px 24px rgba(102, 126, 234, 0.25)'
                          : mode === 'dark'
                          ? '0 12px 24px rgba(129, 140, 248, 0.25)'
                          : '0 12px 24px rgba(255, 107, 53, 0.25)'
                        : mode === 'light'
                        ? '0 12px 24px rgba(102, 126, 234, 0.15), 0 0 0 2px rgba(102, 126, 234, 0.3)'
                        : mode === 'dark'
                        ? '0 12px 24px rgba(0, 0, 0, 0.4), 0 0 0 2px rgba(129, 140, 248, 0.4)'
                        : '0 12px 24px rgba(0, 0, 0, 0.4), 0 0 0 2px rgba(255, 107, 53, 0.4)',
                      borderColor: message.role === 'user'
                        ? 'transparent'
                        : mode === 'light'
                        ? 'rgba(102, 126, 234, 0.4)'
                        : mode === 'dark'
                        ? 'rgba(129, 140, 248, 0.5)'
                        : 'rgba(255, 107, 53, 0.5)',
                    },
                    '& *': {
                      color: message.role === 'user' ? '#ffffff !important' : 'inherit',
                    },
                  }}
                >
                  <Box sx={{ '& > *:first-of-type': { mt: 0 }, '& > *:last-child': { mb: 0 } }}>
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={markdownComponents}
                    >
                      {preprocessMarkdown(message.content)}
                    </ReactMarkdown>
                    {message.isStreaming && (
                      <Box 
                        component="span" 
                        sx={{ 
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 0.5,
                          ml: 0.5,
                        }}
                      >
                        <Box
                          sx={{
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            backgroundColor: 'currentColor',
                            animation: 'typingDot 1.4s infinite',
                            animationDelay: '0s',
                            '@keyframes typingDot': {
                              '0%, 60%, 100%': { opacity: 0.3 },
                              '30%': { opacity: 1 },
                            },
                          }}
                        />
                        <Box
                          sx={{
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            backgroundColor: 'currentColor',
                            animation: 'typingDot 1.4s infinite',
                            animationDelay: '0.2s',
                            '@keyframes typingDot': {
                              '0%, 60%, 100%': { opacity: 0.3 },
                              '30%': { opacity: 1 },
                            },
                          }}
                        />
                        <Box
                          sx={{
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            backgroundColor: 'currentColor',
                            animation: 'typingDot 1.4s infinite',
                            animationDelay: '0.4s',
                            '@keyframes typingDot': {
                              '0%, 60%, 100%': { opacity: 0.3 },
                              '30%': { opacity: 1 },
                            },
                          }}
                        />
                      </Box>
                    )}
                  </Box>
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mt: 1 }}>
                    <Typography
                      variant="caption"
                      sx={{
                        opacity: 0.7,
                      }}
                    >
                      {message.timestamp.toLocaleString()}
                    </Typography>
                    {message.role === 'assistant' && !message.isStreaming && (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <Tooltip title="Copy as Markdown">
                          <IconButton
                            size="small"
                            onClick={() => {
                              navigator.clipboard.writeText(message.content);
                              // Brief visual feedback via button color
                              const btn = document.getElementById(`copy-btn-${message.id}`);
                              if (btn) { btn.style.color = '#4caf50'; setTimeout(() => { btn.style.color = ''; }, 1500); }
                            }}
                            id={`copy-btn-${message.id}`}
                            sx={{ opacity: 0.6, '&:hover': { opacity: 1 }, transition: 'color 0.3s' }}
                          >
                            <ContentCopyIcon sx={{ fontSize: 16 }} />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Export as HTML">
                          <IconButton
                            size="small"
                            onClick={() => {
                              marked.setOptions({ gfm: true, breaks: true });
                              const renderedContent = marked.parse(preprocessMarkdown(message.content)) as string;
                              const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>InsightMate Response</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; color: #1f2937; }
h1, h2, h3, h4 { margin-top: 1em; margin-bottom: 0.5em; }
p { margin: 0.5em 0; line-height: 1.6; }
ul, ol { margin: 0.5em 0; padding-left: 1.5em; }
li { margin: 0.25em 0; }
table { border-collapse: collapse; width: 100%; margin: 0.75em 0; font-size: 14px; }
th, td { border: 1px solid #d1d5db; padding: 8px 12px; text-align: left; }
th { background: rgba(0,0,0,0.06); font-weight: 600; }
a { color: #4f46e5; }
code { background: rgba(0,0,0,0.06); padding: 2px 5px; border-radius: 3px; font-size: 0.9em; }
pre { background: #1e293b; color: #e2e8f0; padding: 12px; border-radius: 6px; overflow-x: auto; }
pre code { background: none; padding: 0; color: inherit; }
blockquote { border-left: 3px solid #667eea; margin: 0.5em 0; padding: 0.5em 1em; background: rgba(102,126,234,0.05); }
strong { font-weight: 600; }
hr { border: none; border-top: 1px solid #d1d5db; margin: 1em 0; }
.meta { color: #666; font-size: 12px; margin-bottom: 20px; }
</style></head><body>
<div class="meta">Exported: ${new Date().toLocaleString()}</div>
${renderedContent}
</body></html>`;
                              const blob = new Blob([html], { type: 'text/html' });
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = `insightmate-response-${new Date().toISOString().slice(0,10)}.html`;
                              a.click();
                              URL.revokeObjectURL(url);
                            }}
                            sx={{ opacity: 0.6, '&:hover': { opacity: 1 } }}
                          >
                            <FileDownloadIcon sx={{ fontSize: 16 }} />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="View debug info">
                          <IconButton
                            size="small"
                            onClick={() => {
                              setSelectedMessage(message);
                              setDebugDialogOpen(true);
                            }}
                            sx={{ opacity: 0.6, '&:hover': { opacity: 1 } }}
                          >
                            <InfoOutlinedIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Box>
                    )}
                  </Box>
                </Paper>
              </Box>
            </Box>
          </Box>
        ))}

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        <div ref={messagesEndRef} />
      </Box>

      {/* Input Area */}
      <Paper
        elevation={3}
        sx={{
          p: 2.5,
          borderTop: 1,
          borderColor: 'divider',
          flexShrink: 0,
          transition: 'transform 0.35s ease, opacity 0.35s ease',
          ...(chromeHidden && {
            transform: 'translateY(100%)',
            opacity: 0,
            pointerEvents: 'none',
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 10,
          }),
          ...(!chromeHidden && {
            position: 'relative',
            zIndex: 10,
          }),
          boxShadow: mode === 'light'
            ? '0 -4px 16px rgba(0, 0, 0, 0.08)'
            : mode === 'dark'
            ? '0 -4px 16px rgba(0, 0, 0, 0.4)'
            : '0 -4px 16px rgba(0, 0, 0, 0.5)',
        }}
      >
        {/* Speech error alert */}
        {speechError && (
          <Alert 
            severity="error" 
            sx={{ mb: 2 }} 
            onClose={() => {
              // Error will be cleared by the hook
            }}
          >
            {speechError}
          </Alert>
        )}

        {/* Model loading indicator */}
        {isModelLoading && (
          <Alert severity="info" sx={{ mb: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <CircularProgress size={16} />
              <Typography variant="body2">
                Loading speech recognition model (first time only, ~75MB)...
              </Typography>
            </Box>
          </Alert>
        )}

        {/* Listening indicator */}
        {isListening && (
          <Box
            sx={{
              mb: 2,
              p: 1.5,
              backgroundColor: alpha(theme.palette.success.main, 0.1),
              borderRadius: 1,
              border: 1,
              borderColor: 'success.main',
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
            }}
          >
            <AudioWaveform isActive={isListening} color={theme.palette.success.main} />
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1 }}>
              <Typography variant="body2" color="success.main" sx={{ fontWeight: 500 }}>
                {isSpeechLoading ? 'Processing...' : 'Listening...'}
              </Typography>
              <Box
                sx={{
                  ml: 'auto',
                  px: 1.5,
                  py: 0.5,
                  backgroundColor: alpha(theme.palette.success.main, 0.2),
                  borderRadius: 1,
                  fontFamily: 'monospace',
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  color: 'success.dark',
                  minWidth: 60,
                  textAlign: 'center',
                }}
              >
                {formatDuration(recordingDuration)}
              </Box>
            </Box>
          </Box>
        )}

        <Box sx={{ display: 'flex', gap: 1 }}>
          <TextField
            fullWidth
            multiline
            maxRows={4}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Ask me anything about your customers..."
            disabled={isLoading || isListening}
            variant="outlined"
            size="medium"
            sx={{
              '& .MuiOutlinedInput-root': {
                backgroundColor: theme.palette.mode === 'dark' 
                  ? alpha(theme.palette.background.paper, 0.5)
                  : alpha(theme.palette.background.paper, 0.8),
                transition: 'all 0.3s ease',
                '&:hover fieldset': {
                  borderColor: theme.palette.mode === 'dark' 
                    ? theme.palette.primary.light 
                    : theme.palette.primary.main,
                },
                '&.Mui-focused': {
                  backgroundColor: theme.palette.mode === 'dark' 
                    ? alpha(theme.palette.background.paper, 0.7)
                    : theme.palette.background.paper,
                  '& fieldset': {
                    borderWidth: 2,
                    borderColor: theme.palette.primary.main,
                    boxShadow: mode === 'light'
                      ? '0 0 0 3px rgba(102, 126, 234, 0.1)'
                      : mode === 'dark'
                      ? '0 0 0 3px rgba(129, 140, 248, 0.2)'
                      : '0 0 0 3px rgba(255, 107, 53, 0.2)',
                  },
                },
              },
              '& .MuiInputBase-input::placeholder': {
                color: theme.palette.text.secondary,
                opacity: 0.8,
              },
            }}
          />
          
          {/* Microphone button */}
          {isSpeechSupported && (
            <Tooltip 
              title={
                isModelLoading 
                  ? 'Loading model...' 
                  : isListening 
                  ? 'Click to stop recording' 
                  : 'Click to start voice input'
              }
            >
              <span>
                <IconButton
                  onClick={handleMicClick}
                  disabled={isLoading || isModelLoading}
                  sx={{
                    width: 48,
                    height: 48,
                    borderRadius: '50%',
                    padding: 1.5,
                    backgroundColor: isListening 
                      ? 'error.main' 
                      : mode === 'light'
                      ? 'rgba(102, 126, 234, 0.1)'
                      : mode === 'dark'
                      ? 'rgba(129, 140, 248, 0.15)'
                      : 'rgba(255, 107, 53, 0.15)',
                    color: isListening 
                      ? 'white' 
                      : mode === 'light'
                      ? '#667eea'
                      : mode === 'dark'
                      ? '#818cf8'
                      : '#ff6b35',
                    border: '2px solid',
                    borderColor: isListening 
                      ? 'error.main'
                      : mode === 'light'
                      ? 'rgba(102, 126, 234, 0.3)'
                      : mode === 'dark'
                      ? 'rgba(129, 140, 248, 0.3)'
                      : 'rgba(255, 107, 53, 0.3)',
                    transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                    animation: isListening ? 'micPulse 1.5s ease-in-out infinite' : 'none',
                    '@keyframes micPulse': {
                      '0%, 100%': {
                        transform: 'scale(1)',
                        boxShadow: mode === 'light'
                          ? '0 0 0 0 rgba(239, 68, 68, 0.7)'
                          : '0 0 0 0 rgba(239, 68, 68, 0.7)',
                      },
                      '50%': {
                        transform: 'scale(1.05)',
                        boxShadow: mode === 'light'
                          ? '0 0 0 8px rgba(239, 68, 68, 0)'
                          : '0 0 0 8px rgba(239, 68, 68, 0)',
                      },
                    },
                    '&:hover': {
                      backgroundColor: isListening 
                        ? 'error.dark'
                        : mode === 'light'
                        ? 'rgba(102, 126, 234, 0.2)'
                        : mode === 'dark'
                        ? 'rgba(129, 140, 248, 0.25)'
                        : 'rgba(255, 107, 53, 0.25)',
                      borderColor: isListening 
                        ? 'error.dark'
                        : mode === 'light'
                        ? 'rgba(102, 126, 234, 0.5)'
                        : mode === 'dark'
                        ? 'rgba(129, 140, 248, 0.5)'
                        : 'rgba(255, 107, 53, 0.5)',
                      transform: 'scale(1.05)',
                    },
                    '&:disabled': {
                      backgroundColor: 'action.disabledBackground',
                      borderColor: 'action.disabled',
                      color: 'action.disabled',
                    },
                  }}
                >
                  {isListening ? <MicIcon /> : <MicIcon />}
                </IconButton>
              </span>
            </Tooltip>
          )}

          {/* Send button */}
          <IconButton
            color="primary"
            onClick={sendMessage}
            disabled={!input.trim() || isLoading}
            sx={{
              width: 48,
              height: 48,
              borderRadius: '50%',
              backgroundColor: 'primary.main',
              color: 'white',
              padding: 1.5,
              '&:hover': {
                backgroundColor: 'primary.dark',
              },
              '&:disabled': {
                backgroundColor: 'action.disabledBackground',
              },
            }}
          >
            {isLoading ? <CircularProgress size={24} color="inherit" /> : <SendIcon />}
          </IconButton>
        </Box>
      </Paper>

      {/* Debug Dialog */}
      <Dialog
        open={debugDialogOpen}
        onClose={() => setDebugDialogOpen(false)}
        maxWidth="md"
        fullWidth
        PaperProps={{
          sx: {
            bgcolor: mode === 'light'
              ? 'rgb(255, 255, 255)'
              : mode === 'dark'
              ? 'rgb(15, 23, 42)'
              : 'rgb(42, 42, 42)',
            backgroundImage: 'none',
          }
        }}
      >
        <DialogTitle sx={{ 
          fontWeight: 700,
          color: theme.palette.primary.main,
          borderBottom: 1,
          borderColor: 'divider',
        }}>
          Debug Information
        </DialogTitle>
        <DialogContent>
          {selectedMessage && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
              <Box>
                <Typography variant="subtitle2" sx={{ 
                  fontWeight: 600, 
                  mb: 1,
                  color: theme.palette.primary.main,
                }}>
                  Session ID
                </Typography>
                <Typography
                  variant="body2"
                  sx={{
                    fontFamily: 'monospace',
                    backgroundColor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
                    p: 1,
                    borderRadius: 1,
                  }}
                >
                  {sessionId}
                </Typography>
              </Box>

              {selectedMessage.thinking && selectedMessage.thinking.length > 0 && (
                <Box>
                  <Typography variant="subtitle2" sx={{ 
                    fontWeight: 600, 
                    mb: 1,
                    color: theme.palette.primary.main,
                  }}>
                    Thinking
                  </Typography>
                  <Box
                    sx={{
                      maxHeight: 300,
                      overflow: 'auto',
                      backgroundColor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
                      p: 2,
                      borderRadius: 1,
                    }}
                  >
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        ...markdownComponents,
                        p: ({ children }) => (
                          <Typography variant="body2" sx={{ mb: 1, fontSize: '0.85rem' }}>
                            {children}
                          </Typography>
                        ),
                      }}
                    >
                      {selectedMessage.thinking.join('')}
                    </ReactMarkdown>
                  </Box>
                </Box>
              )}

              {selectedMessage.toolUse && selectedMessage.toolUse.length > 0 && (() => {
                // Deduplicate tool use entries - keep only the last occurrence of each tool
                const toolMap = new Map<string, string>();
                selectedMessage.toolUse.forEach(entry => {
                  const toolMatch = entry.match(/Tool:\s*([^\n]+)/);
                  if (toolMatch) {
                    const toolName = toolMatch[1].trim();
                    toolMap.set(toolName, entry);
                  }
                });
                const uniqueTools = Array.from(toolMap.values());
                
                return uniqueTools.length > 0 ? (
                  <Box>
                    <Typography variant="subtitle2" sx={{ 
                      fontWeight: 600, 
                      mb: 1,
                      color: theme.palette.primary.main,
                    }}>
                      Tool Use
                    </Typography>
                    <Box
                      sx={{
                        maxHeight: 300,
                        overflow: 'auto',
                        backgroundColor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
                        p: 2,
                        borderRadius: 1,
                      }}
                    >
                      {uniqueTools.map((tool, idx) => (
                        <Box
                          key={idx}
                          sx={{
                            mb: 2,
                            pb: 2,
                            borderBottom: idx < uniqueTools.length - 1 ? '1px solid' : 'none',
                            borderColor: 'divider',
                          }}
                        >
                          <Typography
                            variant="body2"
                            sx={{
                              fontFamily: 'monospace',
                              fontSize: '0.85rem',
                              whiteSpace: 'pre-wrap',
                            }}
                          >
                            {tool}
                          </Typography>
                        </Box>
                      ))}
                    </Box>
                  </Box>
                ) : null;
              })()}

              {(!selectedMessage.thinking || selectedMessage.thinking.length === 0) &&
               (!selectedMessage.toolUse || selectedMessage.toolUse.length === 0) && (
                <Typography variant="body2" color="text.secondary">
                  No debug information available for this message.
                </Typography>
              )}
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDebugDialogOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};
