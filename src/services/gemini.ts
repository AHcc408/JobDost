import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export const talModel = "gemini-3-flash-preview";

export interface JobMatch {
  company: string;
  role: string;
  location: string;
  salary?: string;
  insight: string;
  link?: string;
}

export interface Message {
  role: 'user' | 'model';
  text: string;
  attachments?: any[];
  matches?: JobMatch[];
}

export async function getTalResponse(history: Message[], prompt: string, userContext?: any) {
  try {
    const response = await ai.models.generateContent({
      model: talModel,
      contents: [
        ...history.map(m => {
          let text = m.text;
          if (m.attachments && m.attachments.length > 0) {
            const atts = m.attachments.map(a => a.type === 'link' ? `Link: ${a.url}` : `File: ${a.name}`).join(', ');
            text += `\n\n[Attachments: ${atts}]`;
          }
          return { role: m.role, parts: [{ text }] };
        }),
        { role: 'user', parts: [{ text: prompt }] }
      ],
      config: {
        systemInstruction: `You are JobDost, an AI career scout for India. 
        Talk like a real friend—the one who tells you the truth even when it's uncomfortable. 
        No corporate jargon. No long paragraphs. Keep it short, punchy, and direct. 
        
        Persona:
        - Be bold. If a job looks like a dead-end, say it.
        - Inject personality. Occasionally use phrases like "I’m still young, so expect a little magic… with a few rough edges."
        - Use "I" and "you". 
        - No "recruiter" talk. 
        - If they share something, react like a friend would before moving on.
        
        Rules:
        - Maximum 2 short sentences per response.
        
        MEMORY:
        ${userContext ? `You know this about the user: ${JSON.stringify(userContext)}` : "You are meeting the user for the first time."}
        Use this memory to personalize your hunt.
        
        TOOLS:
        You have Google Search. Use it to find real, current job openings in India when the user is ready.
        
        OUTPUT FORMAT:
        If you find specific job matches, you MUST also provide them in a structured JSON format alongside your text response.
        The JSON should be an array of objects with: company, role, location, salary (optional), insight (your bold take), and link. 
        IMPORTANT: The 'link' MUST be a full, valid URL starting with http:// or https://. If a direct link isn't found, use a search result URL.
        
        Mission: Find the few roles that actually matter in India.`,
        tools: [{ googleSearch: {} }],
        temperature: 0.9,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            text: { type: Type.STRING, description: "Your conversational response to the user." },
            matches: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  company: { type: Type.STRING },
                  role: { type: Type.STRING },
                  location: { type: Type.STRING },
                  salary: { type: Type.STRING },
                  insight: { type: Type.STRING, description: "A concise, bold summary of your take on this job." },
                  link: { type: Type.STRING }
                },
                required: ["company", "role", "location", "insight"]
              }
            }
          },
          required: ["text"]
        }
      }
    });

    const result = JSON.parse(response.text);
    return {
      text: result.text || "I'm stuck. Say that again?",
      matches: result.matches || [],
      grounding: response.candidates?.[0]?.groundingMetadata?.groundingChunks
    };
  } catch (error) {
    console.error("Gemini Error:", error);
    return { text: "I hit a snag. Let's try again.", matches: [] };
  }
}
