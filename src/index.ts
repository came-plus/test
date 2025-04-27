#!/usr/bin/env node

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const pkgPath = resolve(__dirname, '../package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

// Extract command-line arguments parsing into a separate function
function parseArgs(args: string[]): { port: number; bind: string } {
  const portArg = args.find((arg: string) => arg.startsWith('--port='));
  const bindArg = args.find((arg: string) => arg.startsWith('--bind='));

  const port = portArg ? parseInt(portArg.split('=')[1], 10) : 64001;
  const bind = bindArg ? bindArg.split('=')[1] : '0.0.0.0';

  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error('Port must be a valid number between 1 and 65535.');
  }

  return { port, bind };
}

// Use the new function to parse arguments
let port: number, bind: string;
try {
  ({ port, bind } = parseArgs(process.argv.slice(2)));
} catch (error: unknown) {
  console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  process.exit(1);
}

// Create Hono app
const app = new Hono();

// Route for package name and version
app.get('/', (c) => {
  return c.text(`${pkg.name}@${pkg.version}`);
});

// Start server
serve(
  {
    fetch: app.fetch,
    port,
    hostname: bind,
  },
  (info) => {
    console.log(`CAME+test running at http://${info.address}:${info.port}`);
  }
);