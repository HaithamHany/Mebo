#!/usr/bin/env node
// MeBo preflight — a friendly, advisory check you run with `npm run setup`.
//
// It changes nothing and installs nothing. It looks at your machine, tells you
// what is ready and what is missing, and prints the command that starts MeBo.
// Every check degrades to a single friendly line if something is not there,
// and the script always exits 0 — it is advice, not a gate. It never prints a
// credential, only whether one is set.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const tick = '  ok  ';
const warn = ' note ';
const info = '  ·   ';

function line(tag, msg) {
  console.log(`[${tag}] ${msg}`);
}

// The bridge reads the git-ignored .env in the project root; so does this check.
const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // unreadable .env: the environment alone
  }
}

console.log('');
console.log('MeBo preflight — checking your machine (nothing is changed)');
console.log('------------------------------------------------------------');

// --- Node version --------------------------------------------------------
try {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isFinite(major) && major >= 20) {
    line(tick, `Node.js ${process.versions.node} (20+ required).`);
  } else {
    line(warn, `Node.js ${process.versions.node} is below 20. Please upgrade — the bridge needs Node 20 or newer.`);
  }
} catch {
  line(warn, 'Could not read the Node.js version. MeBo needs Node 20 or newer.');
}

// --- Which model ------------------------------------------------------------
const provider = (process.env.LLM_PROVIDER ?? (process.env.HF_TOKEN ? 'huggingface' : 'ollama')).trim().toLowerCase();
line(info, `Model provider: ${provider} (set LLM_PROVIDER=huggingface or ollama in .env).`);

// --- Online: Hugging Face ---------------------------------------------------
if (process.env.HF_TOKEN && process.env.HF_TOKEN.trim()) {
  line(tick, `HF_TOKEN is set (value not shown). Online model: ${process.env.HF_MODEL || 'google/gemma-4-26B-A4B-it'}.`);
} else if (provider === 'huggingface') {
  line(warn, 'LLM_PROVIDER=huggingface but HF_TOKEN is not set. Add it to .env (never to a VITE_ variable).');
} else {
  line(info, 'No HF_TOKEN — online mode is off. Optional: add HF_TOKEN to .env for Hugging Face.');
}

// --- Offline: Ollama -----------------------------------------------------------
const ollamaUrl = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const ollamaModel = process.env.OLLAMA_MODEL || 'gemma4:e4b';
try {
  const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
  const tags = (await res.json()).models?.map((m) => m.name) ?? [];
  if (tags.includes(ollamaModel)) line(tick, `Ollama is running with ${ollamaModel} (offline mode ready).`);
  else line(warn, `Ollama is running but ${ollamaModel} is not pulled. Run: ollama pull ${ollamaModel}`);
} catch {
  line(provider === 'ollama' ? warn : info, `Ollama is not reachable at ${ollamaUrl}. For offline mode install it from ollama.com and run: ollama pull ${ollamaModel}`);
}

// --- Optional premium voice --------------------------------------------------
if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY.trim()) {
  line(tick, 'ELEVENLABS_API_KEY is set (value not shown) — the optional cloud voice is available.');
} else {
  line(info, 'No ElevenLabs key — MeBo speaks with its local Piper voice (that is completely fine).');
}

// --- How to run ----------------------------------------------------------
console.log('');
console.log('To run MeBo:');
console.log('  npm start               # bridge + app (open the URL it prints in Chrome)');
console.log('');
console.log('Then choose "Start Health Check", or say "MeBo".');
console.log('');

process.exit(0);
