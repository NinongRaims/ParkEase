// Netlify build: assembles the static site into ./dist. The API is the Netlify Function in
// netlify/functions/api.mjs, which Netlify routes itself (see its `config.path`) - no proxy needed.
import { cpSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

// pages/*.html and public/* share one root, because the pages use relative links like Styles/x.css
cpSync("public", "dist", { recursive: true });
for (const f of readdirSync("pages")) cpSync(`pages/${f}`, `dist/${f}`);

writeFileSync("dist/_headers", `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: same-origin
/*.html
  Cache-Control: no-store
/
  Cache-Control: no-store
/Styles/*
  Cache-Control: public, max-age=3600
/js/*
  Cache-Control: public, max-age=300
/Images/*
  Cache-Control: public, max-age=86400
/Fonts/*
  Cache-Control: public, max-age=31536000, immutable
`);
console.log("Built dist/ (static site). API runs as a Netlify Function.");
