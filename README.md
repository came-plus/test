# came.plus/test
https://came.plus/test: Simple CAME+ testing framework by Dietmar Scharf | Ramteid GmbH

## Quick Start
Run the agent with default settings:

```bash
# Starts server on port 64001, accessible from all interfaces (0.0.0.0)
npx "@came.plus/test"
```

## Custom Configuration

```bash
# Start with custom port and binding address
npx "@came.plus/test" --port=64000 --bind=127.0.0.1
```

## System Installation

```bash
# Install as a system service/daemon
npx "@came.plus/test" install
```

## For Developers
Add to your TypeScript project:

```bash
npm install @came.plus/test
```
