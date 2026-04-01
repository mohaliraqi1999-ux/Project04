import type { VercelRequest, VercelResponse } from '@vercel/node';
import Groq from "groq-sdk";
import * as Ably from "ably";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_ANON_KEY || '';
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { text } = req.body;
    if (!text) throw new Error("No text provided");
    if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set");
    
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "You are an OSINT analyst. Extract the event details and location from the following raw Telegram message. If no coordinates are present, search your internal knowledge for the city name and provide the center-point coordinates. Output ONLY a valid JSON object representing the event."
        },
        {
          role: "user",
          content: `Raw message: "${text}"
          
          Return ONLY a valid JSON object with these exact properties:
          - id (string, unique)
          - title (string)
          - description (string)
          - latitude (number)
          - longitude (number)
          - impactLatitude (number, OPTIONAL)
          - impactLongitude (number, OPTIONAL)
          - missileCount (number, OPTIONAL)
          - locationName (string)
          - type (string, MUST be one of: missile_launch, kinetic_strike, drone_attack, airstrike, combat, diplomatic, alert, naval, other)
          - date (string, ISO 8601 format)
          - source (string, URL if available)`
        }
      ],
      model: "llama-3.3-70b-versatile",
      temperature: 0.1,
    });

    let out = completion.choices[0]?.message?.content || '{}';
    out = out.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsedEvent = JSON.parse(out);
    
    // Supabase Logic
    if (supabase) {
      const eventToInsert = {
        id: crypto.randomUUID(),
        title: parsedEvent.title || 'Unknown Event',
        description: (parsedEvent.description || '') + (parsedEvent.missileCount > 1 ? `\n\n[Missile Count: ${parsedEvent.missileCount}]` : ''),
        latitude: parsedEvent.latitude !== undefined ? Number(parsedEvent.latitude) : null,
        longitude: parsedEvent.longitude !== undefined ? Number(parsedEvent.longitude) : null,
        impactLatitude: parsedEvent.impactLatitude !== undefined ? Number(parsedEvent.impactLatitude) : null,
        impactLongitude: parsedEvent.impactLongitude !== undefined ? Number(parsedEvent.impactLongitude) : null,
        missileCount: parsedEvent.missileCount !== undefined ? Number(parsedEvent.missileCount) : 1,
        locationName: parsedEvent.locationName || '',
        type: parsedEvent.type || 'other',
        date: new Date().toISOString(),
        source: parsedEvent.source || ''
      };
      
      await supabase.from('osint_events').insert([eventToInsert]);
    }
    
    // Ably Logic
    if (process.env.VITE_ABLY_API_KEY) {
      const ably = new Ably.Rest({ key: process.env.VITE_ABLY_API_KEY });
      const channel = ably.channels.get('telegram-events');
      await channel.publish('message', JSON.stringify(parsedEvent));
    }
    
    return res.status(200).json(parsedEvent);
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ error: error instanceof Error ? error.message : "Failed to process message" });
  }
}