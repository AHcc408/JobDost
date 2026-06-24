import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Send, User, Sparkles, LogOut, Briefcase, Target, ShieldAlert, Heart, Mic, MicOff, Globe, ExternalLink, Paperclip, Link as LinkIcon, Plus, X, FileText } from 'lucide-react';
import { auth, db, googleProvider, signInWithPopup, signOut, onAuthStateChanged, doc, getDoc, setDoc, collection, onSnapshot, query, orderBy, FirebaseUser, getDocFromServer } from './firebase';
import { getTalResponse, Message, JobMatch } from './services/gemini';
import { JobDostVoiceSession } from './services/voice';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import Markdown from 'react-markdown';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: any, operationType: OperationType, path: string | null, customUser?: FirebaseUser | null) {
  const activeUser = customUser || auth.currentUser;
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: activeUser?.uid,
      email: activeUser?.email,
      emailVerified: activeUser?.emailVerified,
      isAnonymous: activeUser?.isAnonymous,
      tenantId: activeUser?.tenantId,
      providerInfo: activeUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

function JobCard({ match }: { match: JobMatch }) {
  return (
    <motion.div 
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      className="w-full max-w-sm glass border border-white/10 rounded-2xl p-5 space-y-4 hover:border-orange-500/30 transition-all group"
    >
      <div className="flex justify-between items-start">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Briefcase className="w-4 h-4 text-orange-500" />
            <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold">New Match</span>
          </div>
          <h3 className="text-lg font-display font-bold text-white leading-tight">{match.role}</h3>
          <p className="text-sm text-zinc-400 font-medium">{match.company}</p>
        </div>
        {match.link && (
          <a 
            href={match.link} 
            target="_blank" 
            rel="noopener noreferrer"
            className="p-2 glass rounded-xl text-zinc-400 hover:text-white hover:bg-orange-500/20 transition-all"
          >
            <ExternalLink className="w-4 h-4" />
          </a>
        )}
      </div>

      <div className="flex items-center gap-4 text-xs text-zinc-500">
        <div className="flex items-center gap-1.5">
          <Globe className="w-3.5 h-3.5" />
          {match.location}
        </div>
        {match.salary && (
          <div className="flex items-center gap-1.5">
            <Target className="w-3.5 h-3.5" />
            {match.salary}
          </div>
        )}
      </div>

      <div className="relative p-3 bg-orange-500/5 rounded-xl border border-orange-500/10">
        <div className="absolute -top-2 -left-1 px-2 py-0.5 bg-orange-500 text-[8px] uppercase font-black tracking-tighter rounded-sm">
          JobDost Insight
        </div>
        <p className="text-xs text-zinc-300 leading-relaxed italic">
          "{match.insight}"
        </p>
      </div>
    </motion.div>
  );
}

interface GroundingChunk {
  web?: { uri?: string; title?: string };
}

interface Attachment {
  type: 'link' | 'file';
  name: string;
  url?: string;
  content?: string; // base64 for small files
}

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [userData, setUserData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<(Message & { grounding?: GroundingChunk[]; attachments?: Attachment[] })[]>([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isVoiceMode, setIsVoiceMode] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState('');
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const voiceSession = useRef<JobDostVoiceSession | null>(null);

  useEffect(() => {
    async function testConnection() {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if(error instanceof Error && error.message.includes('the client is offline')) {
          setErrorMessage("Please check your Firebase configuration. The client is offline.");
        }
      }
    }
    testConnection();

    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
      if (u) {
        // Sync user profile
        const userDocRef = doc(db, 'users', u.uid);
        const unsubProfile = onSnapshot(userDocRef, (doc) => {
          if (doc.exists()) {
            setUserData(doc.data());
          }
        }, (error) => {
          handleFirestoreError(error, OperationType.GET, `users/${u.uid}`, u);
        });

        // Sync messages
        const messagesRef = collection(db, 'users', u.uid, 'messages');
        const q = query(messagesRef, orderBy('createdAt', 'asc'));
        const unsubMessages = onSnapshot(q, (snapshot) => {
          const loadedMessages = snapshot.docs.map(doc => ({
            role: doc.data().role as 'user' | 'model',
            text: doc.data().text,
            grounding: doc.data().grounding,
            matches: doc.data().matches
          }));
          
          if (loadedMessages.length > 0) {
            setMessages(loadedMessages);
          } else {
            startOnboarding();
          }
        }, (error) => {
          handleFirestoreError(error, OperationType.LIST, `users/${u.uid}/messages`, u);
        });

        return () => {
          unsubProfile();
          unsubMessages();
        };
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  const startOnboarding = async () => {
    if (!user) return;
    setIsTyping(true);
    const intro = "I'm JobDost. I hunt for jobs in India that actually matter, not just the ones that pay the bills.\n\nI’m still young, so expect a little magic… with a few rough edges.\n\nTo start, tell me: **What are your big career ambitions?** And just as importantly, **what are your non-negotiables?** (e.g., no night shifts, specific city, minimum salary).\n\nFeel free to drop a link to your portfolio or upload your resume using the '+' button below.";
    
    const messagesRef = collection(db, 'users', user.uid, 'messages');
    try {
      await setDoc(doc(messagesRef), {
        role: 'model',
        text: intro,
        createdAt: new Date().toISOString()
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `users/${user.uid}/messages`, user);
    }
    setIsTyping(false);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Limit to 500KB to stay safe within Firestore's 1MB document limit
    if (file.size > 500 * 1024) {
      setErrorMessage("File is too large. Please keep it under 500KB.");
      setTimeout(() => setErrorMessage(null), 5000);
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const attachment: Attachment = {
        type: 'file',
        name: file.name,
        content: event.target?.result as string
      };
      setPendingAttachments(prev => [...prev, attachment]);
    };
    reader.readAsDataURL(file);
    setShowAttachMenu(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleAddLink = () => {
    const url = prompt("Enter the URL (e.g., Portfolio, LinkedIn, GitHub):");
    if (url) {
      let normalizedUrl = url.trim();
      if (!/^https?:\/\//i.test(normalizedUrl)) {
        normalizedUrl = `https://${normalizedUrl}`;
      }
      const attachment: Attachment = {
        type: 'link',
        name: url,
        url: normalizedUrl
      };
      setPendingAttachments(prev => [...prev, attachment]);
    }
    setShowAttachMenu(false);
  };

  const removeAttachment = (index: number) => {
    setPendingAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const handleSend = async (overrideInput?: string) => {
    const messageText = overrideInput || input.trim();
    if ((!messageText && pendingAttachments.length === 0) || isTyping || !user) return;

    if (!overrideInput) setInput('');
    const attachmentsToSave = [...pendingAttachments];
    setPendingAttachments([]);
    
    // Save user message
    const messagesRef = collection(db, 'users', user.uid, 'messages');
    const sanitizedAttachments = attachmentsToSave.map(a => ({
      type: a.type,
      name: a.name,
      url: a.url || null,
      content: a.content || null
    }));

    try {
      await setDoc(doc(messagesRef), {
        role: 'user',
        text: messageText || (attachmentsToSave.length > 0 ? "Attached files/links" : ""),
        attachments: sanitizedAttachments,
        createdAt: new Date().toISOString()
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `users/${user.uid}/messages`, user);
    }

    setIsTyping(true);

    // Include attachment info in the prompt for Gemini
    const attachmentContext = attachmentsToSave.map(a => 
      a.type === 'link' ? `Link: ${a.url}` : `File: ${a.name}`
    ).join(', ');
    
    const fullPrompt = messageText + (attachmentContext ? `\n\n[Attachments: ${attachmentContext}]` : "");

    const result = await getTalResponse(messages, fullPrompt, userData);
    
    // Save model response
    try {
      await setDoc(doc(messagesRef), {
        role: 'model',
        text: result.text,
        grounding: result.grounding || null,
        matches: result.matches || null,
        createdAt: new Date().toISOString()
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `users/${user.uid}/messages`, user);
    }

    setIsTyping(false);

    // Memory: Extract profile info
    const updates: any = { updatedAt: new Date().toISOString() };
    
    // Simple extraction logic
    if (!userData?.fullName && messages.length <= 2) {
      updates.fullName = messageText;
    }

    if (attachmentsToSave.length > 0) {
      const currentAttachments = userData?.attachments || [];
      const newAttachments = attachmentsToSave.map(a => ({ 
        type: a.type, 
        name: a.name, 
        url: a.url || null 
      }));
      updates.attachments = [...currentAttachments, ...newAttachments];
    }
    
    // Look for career goals or skills
    const lowerText = messageText.toLowerCase();
    if (lowerText.includes('goal') || lowerText.includes('want to be') || lowerText.includes('aim') || lowerText.includes('ambition')) {
      updates.careerGoals = [...(userData?.careerGoals || []), messageText];
    }
    if (lowerText.includes('skill') || lowerText.includes('expert in') || lowerText.includes('know') || lowerText.includes('portfolio')) {
      updates.skills = [...(userData?.skills || []), messageText];
    }
    if (lowerText.includes('prefer') || lowerText.includes('like') || lowerText.includes('location') || lowerText.includes('boundary') || lowerText.includes('negotiable')) {
      updates.preferences = [...(userData?.preferences || []), messageText];
    }

    try {
      await setDoc(doc(db, 'users', user.uid), updates, { merge: true });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `users/${user.uid}`, user);
    }
  };

  const toggleVoice = async () => {
    if (isVoiceMode) {
      voiceSession.current?.disconnect();
      setIsVoiceMode(false);
      setVoiceStatus('');
    } else {
      voiceSession.current = new JobDostVoiceSession();
      setIsVoiceMode(true);
      setVoiceStatus('Connecting...');
      await voiceSession.current.connect(
        (text) => {
          setMessages(prev => [...prev, { role: 'model', text }]);
        },
        (status) => setVoiceStatus(status),
        userData
      );
    }
  };

  const handleGoogleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Login error:", error);
    }
  };

  if (loading) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-[#050505]">
        <motion.div 
          animate={{ scale: [1, 1.2, 1], opacity: [0.5, 1, 0.5] }}
          transition={{ repeat: Infinity, duration: 2 }}
          className="w-12 h-12 rounded-full bg-orange-500 blur-xl"
        />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="h-screen w-full flex flex-col items-center justify-center bg-[#050505] tal-gradient p-6">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full text-center space-y-8"
        >
          <div className="space-y-4">
            <h1 className="text-6xl font-display font-bold tracking-tighter">JobDost.</h1>
            <p className="text-zinc-400 text-lg">Your AI career scout for India. Finding the roles that actually matter.</p>
          </div>
          
          <button 
            onClick={handleGoogleLogin}
            className="w-full py-4 px-6 glass rounded-2xl flex items-center justify-center gap-3 hover:bg-white/10 transition-all group"
          >
            <img src="https://www.google.com/favicon.ico" className="w-5 h-5" alt="Google" />
            <span className="font-medium">Start your hunt</span>
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="h-screen w-full flex flex-col bg-[#050505] tal-gradient overflow-hidden">
      {/* Header */}
      <header className="p-4 flex items-center justify-between glass border-b-0 rounded-b-3xl mx-4 mt-4 z-10">
        <div className="flex items-center gap-3">
          <motion.div 
            animate={{ 
              scale: isVoiceMode ? [1, 1.2, 1] : [1, 1.1, 1],
              rotate: isVoiceMode ? [0, 10, -10, 0] : [0, 5, -5, 0]
            }}
            transition={{ 
              duration: isVoiceMode ? 1 : 4, 
              repeat: Infinity, 
              ease: "easeInOut" 
            }}
            className={cn(
              "w-10 h-10 rounded-full flex items-center justify-center border",
              isVoiceMode ? "bg-orange-500/40 border-orange-500" : "bg-orange-500/20 border-orange-500/30"
            )}
          >
            <Sparkles className={cn("w-5 h-5", isVoiceMode ? "text-white" : "text-orange-500")} />
          </motion.div>
          <div>
            <h2 className="font-display font-bold tracking-tight">JobDost</h2>
            <div className="flex items-center gap-1.5">
              <div className={cn("w-1.5 h-1.5 rounded-full animate-pulse", isVoiceMode ? "bg-orange-500" : "bg-emerald-500")} />
              <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold">
                {isVoiceMode ? `Voice: ${voiceStatus}` : "Hunting Active"}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={toggleVoice}
            className={cn(
              "p-2 rounded-xl transition-all",
              isVoiceMode ? "bg-orange-500 text-white" : "glass text-zinc-500 hover:text-white"
            )}
          >
            {isVoiceMode ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
          </button>
          <button 
            onClick={() => signOut(auth)}
            className="p-2 hover:bg-white/5 rounded-xl transition-colors text-zinc-500 hover:text-white"
          >
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Chat Area */}
      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-6 space-y-8 scrollbar-hide"
      >
        <AnimatePresence initial={false}>
          {messages.map((msg, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: "spring", stiffness: 260, damping: 20 }}
              className={cn("flex w-full", msg.role === 'user' ? "justify-end" : "justify-start")}
            >
              <div className={cn(
                "max-w-[85%] p-4 rounded-2xl text-sm leading-relaxed relative overflow-hidden",
                msg.role === 'user' ? "bg-white text-black font-medium rounded-tr-none" : "glass text-zinc-200 rounded-tl-none"
              )}>
                {msg.role === 'model' && i === 0 && (
                  <motion.div 
                    initial={{ width: 0 }}
                    animate={{ width: "100%" }}
                    transition={{ duration: 1.5 }}
                    className="absolute top-0 left-0 h-[2px] bg-orange-500/50"
                  />
                )}
                <div className="markdown-body prose prose-invert prose-sm max-w-none">
                  <Markdown
                    components={{
                      a: ({ node, ...props }) => (
                        <a {...props} target="_blank" rel="noopener noreferrer" className="text-orange-400 hover:orange-300 underline" />
                      )
                    }}
                  >
                    {msg.text}
                  </Markdown>
                </div>

                {/* Job Matches */}
                {msg.matches && msg.matches.length > 0 && (
                  <div className="mt-6 flex flex-col gap-4">
                    {msg.matches.map((match, idx) => (
                      <JobCard key={idx} match={match} />
                    ))}
                  </div>
                )}

                {/* Attachments in message */}
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {msg.attachments.map((att, idx) => (
                      <div key={idx} className="flex items-center gap-2 px-3 py-1.5 bg-white/10 rounded-xl border border-white/10 text-xs">
                        {att.type === 'link' ? <LinkIcon className="w-3 h-3 text-orange-400" /> : <FileText className="w-3 h-3 text-orange-400" />}
                        <span className="truncate max-w-[150px]">{att.name}</span>
                        {att.url && (
                          <a href={att.url} target="_blank" rel="noopener noreferrer" className="text-orange-400 hover:text-orange-300">
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                
                {/* Grounding Links */}
                {msg.grounding && msg.grounding.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-white/10 space-y-2">
                    <div className="flex items-center gap-2 text-[10px] text-zinc-500 uppercase font-bold tracking-widest">
                      <Globe className="w-3 h-3" />
                      Sources
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {msg.grounding.map((chunk, idx) => chunk.web && (
                        <a 
                          key={idx}
                          href={chunk.web.uri}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1.5 px-2 py-1 glass rounded-lg text-[10px] hover:bg-white/10 transition-colors"
                        >
                          {chunk.web.title}
                          <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          ))}
          {isTyping && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex justify-start">
              <div className="glass p-4 rounded-2xl rounded-tl-none flex gap-1">
                <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ repeat: Infinity, duration: 1 }} className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
                <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ repeat: Infinity, duration: 1, delay: 0.2 }} className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
                <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ repeat: Infinity, duration: 1, delay: 0.4 }} className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Error Message Toast */}
      <AnimatePresence>
        {errorMessage && (
          <motion.div 
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-6 py-3 bg-red-500 text-white rounded-2xl shadow-2xl flex items-center gap-3"
          >
            <ShieldAlert className="w-5 h-5" />
            <span className="text-sm font-medium">{errorMessage}</span>
            <button onClick={() => setErrorMessage(null)} className="ml-2 hover:opacity-70">
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Input Area */}
      <div className="p-6 pt-0">
        <div className="max-w-3xl mx-auto space-y-4">
          {/* Pending Attachments */}
          {pendingAttachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-2">
              {pendingAttachments.map((att, i) => (
                <motion.div 
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  key={i} 
                  className="flex items-center gap-2 px-3 py-1.5 glass rounded-xl border border-orange-500/30 text-xs group"
                >
                  {att.type === 'link' ? <LinkIcon className="w-3 h-3 text-orange-500" /> : <FileText className="w-3 h-3 text-orange-500" />}
                  <span className="truncate max-w-[120px]">{att.name}</span>
                  <button onClick={() => removeAttachment(i)} className="hover:text-red-500 transition-colors">
                    <X className="w-3 h-3" />
                  </button>
                </motion.div>
              ))}
            </div>
          )}

          <div className="relative flex items-center gap-2">
            <div className="relative">
              <button 
                onClick={() => setShowAttachMenu(!showAttachMenu)}
                className={cn(
                  "p-3 rounded-2xl transition-all",
                  showAttachMenu ? "bg-orange-500 text-white" : "glass text-zinc-500 hover:text-white"
                )}
              >
                <Plus className={cn("w-6 h-6 transition-transform", showAttachMenu && "rotate-45")} />
              </button>

              <AnimatePresence>
                {showAttachMenu && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10, scale: 0.9 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.9 }}
                    className="absolute bottom-full left-0 mb-4 w-48 glass rounded-2xl p-2 shadow-2xl border border-white/10 z-50"
                  >
                    <button 
                      onClick={handleAddLink}
                      className="w-full flex items-center gap-3 p-3 hover:bg-white/5 rounded-xl text-sm transition-colors"
                    >
                      <LinkIcon className="w-4 h-4 text-orange-500" />
                      Add Link
                    </button>
                    <button 
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full flex items-center gap-3 p-3 hover:bg-white/5 rounded-xl text-sm transition-colors"
                    >
                      <Paperclip className="w-4 h-4 text-orange-500" />
                      Upload File
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileUpload} 
                className="hidden" 
                accept=".pdf,.doc,.docx,.png,.jpg,.jpeg"
              />
            </div>

            <div className="flex-1 relative">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                placeholder={isVoiceMode ? "JobDost is listening..." : "Talk to JobDost..."}
                className="w-full bg-white/5 border border-white/10 rounded-2xl py-4 pl-6 pr-14 focus:outline-none focus:border-orange-500/50 transition-all placeholder:text-zinc-600"
              />
              <button 
                onClick={() => handleSend()}
                disabled={(!input.trim() && pendingAttachments.length === 0) || isTyping}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2.5 bg-white text-black rounded-xl hover:bg-zinc-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Send className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
