# came.plus/test
https://came.plus/test: Simple CAME+ testing framework by Dietmar Scharf | Ramteid GmbH

## Quick Start
Run the agent with default settings:

```bash
# Starts server on port 64001, accessible from all interfaces (0.0.0.0)
npx "@came.plus/test"
```

## Command-Line Options

```bash
# Show help and available options
npx "@came.plus/test" --help

# Display version information
npx "@came.plus/test" --version

# Start with custom port and binding address
npx "@came.plus/test" --port=64000 --bind=127.0.0.1

# Enable IPv6 dual-stack mode (binds to ::)
npx "@came.plus/test" --ipv6
```

## System Installation

The CAME+ test server can be installed as a system service, allowing it to run automatically at system startup:

```bash
# Install as a system service with default settings
npx "@came.plus/test" install

# Install as a service with custom port
npx "@came.plus/test" install --port=8080

# Install as a service with localhost binding only
npx "@came.plus/test" install --bind=127.0.0.1

# Install as a service with IPv6 support
npx "@came.plus/test" install --ipv6
```

> **Note:** Installing as a system service requires administrator privileges on Windows or root privileges on Linux/macOS.

### On Windows

The installation process will:
1. Create a Windows service named "CAME+Test"
2. Configure it to start automatically at system boot
3. Launch the service immediately

If you have NSSM (Non-Sucking Service Manager) installed, it will be used for better service management. Otherwise, the native Windows Service Controller (sc.exe) will be used.

### On Linux and macOS

Support for automatic service installation on Linux and macOS is coming soon. For now, you can manually create:
- A systemd service on Linux
- A launchd service on macOS

## For Developers
Add to your TypeScript project:

```bash
npm install "@came.plus/test"
# or:
npm i @came.plus/test
```
