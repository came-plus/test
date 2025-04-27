#!/usr/bin/env node

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { networkInterfaces, hostname as osHostname } from 'os';
import * as dns from 'dns';
import { execSync, spawn } from 'child_process';
import { createServer } from 'net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const pkgPath = resolve(__dirname, '../package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

console.log(`CAME+test version: ${pkg.version}`);

// Function to display help/usage information
function showHelp(): void {
  console.log(`
${pkg.name} v${pkg.version}
${pkg.description}

USAGE:
  npx "@came.plus/test" [OPTIONS]
  npx "@came.plus/test" install [OPTIONS]
  npx "@came.plus/test" uninstall

OPTIONS:
  --help                 Show this help message and exit
  --version              Show version information and exit
  --port=NUMBER          Set the port to listen on (default: 64001)
  --bind=ADDRESS         Set the address to bind to (default: 0.0.0.0)
  --ipv6                 Use IPv6 dual-stack mode (bind defaults to :: for IPv6)

COMMANDS:
  install                Install as a system service (requires admin/root privileges)
  uninstall              Remove the installed system service (requires admin/root privileges)

EXAMPLES:
  npx "@came.plus/test"                      # Start with default settings (port 64001, all IPv4 interfaces)
  npx "@came.plus/test" --port=8080          # Start on port 8080
  npx "@came.plus/test" --bind=127.0.0.1     # Only listen on localhost
  npx "@came.plus/test" --ipv6               # Enable IPv6 dual-stack mode
  npx "@came.plus/test" install              # Install as a system service with default settings
  npx "@came.plus/test" install --port=8080  # Install as a system service on port 8080
  npx "@came.plus/test" uninstall            # Remove the installed system service
`);
  process.exit(0);
}

// Extract command-line arguments parsing into a separate function
function parseArgs(args: string[]): { port: number; bind: string } {
  // Check for help or version flags first
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(`${pkg.name} v${pkg.version}`);
    process.exit(0);
  }

  // Check for uninstall command
  if (args.includes('uninstall')) {
    uninstallService();
    process.exit(0);
  }

  // Check for install command
  if (args.includes('install')) {
    const portArg = args.find((arg: string) => arg.startsWith('--port='));
    const bindArg = args.find((arg: string) => arg.startsWith('--bind='));
    const ipv6Arg = args.find((arg: string) => arg === '--ipv6');

    const port = portArg ? parseInt(portArg.split('=')[1], 10) : 64001;
    const bind = bindArg ? bindArg.split('=')[1] : (ipv6Arg ? '::' : '0.0.0.0');

    if (isNaN(port) || port < 1 || port > 65535) {
      throw new Error('Port must be a valid number between 1 and 65535.');
    }

    // Install the service with the specified parameters
    installService(port, bind, !!ipv6Arg);
    process.exit(0);
  }

  const portArg = args.find((arg: string) => arg.startsWith('--port='));
  const bindArg = args.find((arg: string) => arg.startsWith('--bind='));
  const ipv6Arg = args.find((arg: string) => arg === '--ipv6');

  const port = portArg ? parseInt(portArg.split('=')[1], 10) : 64001;

  // If --ipv6 flag is passed, default to IPv6 unspecified address
  // Otherwise default to IPv4 unspecified address
  const defaultBind = ipv6Arg ? '::' : '0.0.0.0';
  const bind = bindArg ? bindArg.split('=')[1] : defaultBind;

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

// Add helper function to check if an IPv6 address is special
function isSpecialIPv6(address: string): boolean {
  // Check for IPv6 localhost (::1)
  if (address === '::1') return true;

  // Check for IPv6 unspecified address (::)
  if (address === '::') return true;

  // Check for IPv6 link-local addresses (fe80::)
  if (address.startsWith('fe80:')) return true;

  // Check for IPv6 unique local addresses (fc00:: or fd00::)
  if (address.startsWith('fc00:') || address.startsWith('fd00:')) return true;

  return false;
}

// Helper function to check if IPv6 is enabled on the system
function isIPv6Enabled(): boolean {
  try {
    const interfaces = networkInterfaces();
    for (const ifName in interfaces) {
      const networkInterface = interfaces[ifName];
      if (networkInterface) {
        for (const iface of networkInterface) {
          if (iface.family === 'IPv6') {
            return true;
          }
        }
      }
    }
    return false;
  } catch (error) {
    // If there's an error checking interfaces, assume IPv6 is not enabled
    return false;
  }
}

// Helper function to check if an address is IPv4
function isIPv4Address(address: string): boolean {
  // Check if it's an IPv4 address
  // IPv4 addresses have the format: x.x.x.x where x is a number between 0-255
  return /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(address);
}

// Helper function to determine if IPv6 should be shown based on binding address
function shouldShowIPv6(bindAddress: string, ipv6Enabled: boolean): boolean {
  // IPv6 should only be shown if:
  // 1. IPv6 is enabled on the system
  // 2. We're binding to an IPv6 address (not an IPv4 address)

  // If IPv6 is not enabled, we should never show IPv6 addresses
  if (!ipv6Enabled) {
    return false;
  }

  // When binding to 0.0.0.0 (all IPv4 interfaces), don't show IPv6
  // as it's an IPv4-only binding
  if (bindAddress === '0.0.0.0') {
    return false;
  }

  // For any other IPv4 address, don't show IPv6
  if (isIPv4Address(bindAddress)) {
    return false;
  }

  // Otherwise, show IPv6 (for IPv6 bindings like ::, ::1, etc.)
  return true;
}

// Helper function to check if a port is in use
function isPortInUse(port: number, hostname: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true); // Port is in use
      } else {
        resolve(false); // Some other error
      }
    });

    server.once('listening', () => {
      // Close the server if it manages to listen
      server.close(() => {
        resolve(false); // Port is free
      });
    });

    // Try to listen on the port
    server.listen(port, hostname);
  });
}

// Helper function to find an application using a port (Windows-specific)
function findProcessUsingPort(port: number): string | null {
  try {
    if (process.platform === 'win32') {
      // For Windows
      const output = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' });
      const lines = output.split('\n').filter(line => line.trim().length > 0);

      if (lines.length > 0) {
        // Extract PID from the last column
        const pidMatch = lines[0].match(/(\d+)\s*$/);
        if (pidMatch && pidMatch[1]) {
          const pid = pidMatch[1];
          try {
            // Get process name using tasklist
            const tasklistOutput = execSync(`tasklist /fi "PID eq ${pid}" /fo csv /nh`, { encoding: 'utf8' });
            const processMatch = tasklistOutput.match(/"([^"]+)"/);
            if (processMatch && processMatch[1]) {
              return `${processMatch[1]} (PID: ${pid})`;
            }
            return `Process with PID ${pid}`;
          } catch {
            return `Process with PID ${pid}`;
          }
        }
      }
    } else if (process.platform === 'linux' || process.platform === 'darwin') {
      // For Linux/macOS
      try {
        const output = execSync(`lsof -i :${port} | grep LISTEN`, { encoding: 'utf8' });
        const lines = output.split('\n').filter(line => line.trim().length > 0);
        if (lines.length > 0) {
          const parts = lines[0].split(/\s+/);
          if (parts.length > 1) {
            return `${parts[0]} (PID: ${parts[1]})`;
          }
        }
      } catch {
        // Command failed, but we can still return a generic message
      }
    }
  } catch (error) {
    // Command execution failed, ignore
  }

  return null; // Could not determine the process
}

// Helper function to suggest a free port
async function findAvailablePort(startPort: number, hostname: string): Promise<number> {
  let port = startPort;

  // Try the next 10 ports
  for (let i = 0; i < 10; i++) {
    if (!(await isPortInUse(port, hostname))) {
      return port;
    }
    port++;
  }

  // If all are in use, return a common alternative port
  return port === startPort ? 8080 : startPort + 10;
}

// Check if the port is available before starting the server
isPortInUse(port, bind).then(async (inUse) => {
  if (inUse) {
    // Try to get information about what's using the port
    const processInfo = findProcessUsingPort(port);

    console.error(`\nError: Port ${port} is already in use on ${bind}${processInfo ? ` by ${processInfo}` : ''}`);

    // Find an available port to suggest
    const suggestedPort = await findAvailablePort(port + 1, bind);

    console.error('\nYou have several options:');
    console.error(`1. Specify a different port with the port option:`);
    console.error(`   npx "@came.plus/test" --port=${suggestedPort}${bind !== '0.0.0.0' ? ` --bind=${bind}` : ''}${bind === '::' || bind.includes(':') ? ' --ipv6' : ''}`);
    console.error('\n2. Stop the application that is using the port');
    console.error('   To see on your own what\'s using the port, run:');
    if (process.platform === 'win32') {
      console.error('   netstat -ano | findstr :' + port);
    } else {
      console.error('   run: lsof -i :' + port);
    }
    console.error('\n3. Use the system service instead of running directly:');
    console.error(`   npx "@came.plus/test" install${suggestedPort !== 64001 ? ` --port=${suggestedPort}` : ''}`);

    process.exit(1);
  } else {
    // Port is available, start the server
    startServer();
  }
}).catch(() => {
  // On error checking the port, try to start anyway
  startServer();
});

// Add proper typings for Node.js errors which include the code property
interface NodeJSError extends Error {
  code?: string;
  errno?: number;
  syscall?: string;
  address?: string;
  port?: number;
}

// Function to start the server
function startServer() {
  // Create a custom error handler function
  const errorHandler = (error: NodeJSError) => {
    // Handle server errors gracefully
    if (error.code === 'EADDRINUSE') {
      console.error(`\nError: Port ${port} is already in use on ${bind}.`);
      console.error(`Try using a different port with --port=<number>`);
      console.error(`Example: npx "@came.plus/test" --port=${port + 1000}`);
    } else {
      console.error(`\nServer error: ${error.message}`);
    }
    process.exit(1);
  };

  // Add event listener for uncaught errors
  process.on('uncaughtException', (error: NodeJSError) => {
    if (error.code === 'EADDRINUSE') {
      errorHandler(error);
    } else {
      throw error; // Re-throw other errors
    }
  });

  serve(
    {
      fetch: app.fetch,
      port,
      hostname: bind,
    },
    (info) => {
      // Check if IPv6 is enabled
      const ipv6Enabled = isIPv6Enabled();

      // Determine if IPv6 addresses should be shown based on binding address
      const showIPv6 = shouldShowIPv6(bind, ipv6Enabled);

      // Handle the "listen on all interfaces" case - both IPv4 and IPv6
      if (bind === '0.0.0.0' || bind === '::') {
        const interfaces = networkInterfaces();

        if (bind === '::' && !ipv6Enabled) {
          console.error('Error: Cannot bind to IPv6 unspecified address (::) because IPv6 is not enabled on this system.');
          process.exit(1);
        }

        console.log(`Server started and listening on port ${info.port} with binding ${bind}${bind === '::' ? ' (Using IPv6 dual-stack mode)' : bind === '0.0.0.0' ? ' (IPv4-only mode)' : ''}`);
        console.log('Available on:');

        // Define network interface type for TypeScript
        interface NetworkInterfaceInfo {
          address: string;
          netmask: string;
          family: string | 'IPv4' | 'IPv6' | '4' | '6';
          cidr: string | null;
          internal: boolean;
          mac: string;
          scopeid?: number;
        }

        // Track processed URLs to avoid duplicates
        const processedUrls = new Set<string>();

        // Add localhost for convenience
        console.log(`  http://localhost:${info.port}`);
        processedUrls.add(`localhost:${info.port}`);

        // Only show IPv6 localhost if allowed
        if (showIPv6) {
          console.log(`  http://[::1]:${info.port}`);
          processedUrls.add(`[::1]:${info.port}`);
        }

        // List all network interfaces
        const promises: Promise<void>[] = [];

        Object.keys(interfaces).forEach(ifName => {
          const networkInterface = interfaces[ifName];
          if (networkInterface) {
            networkInterface.forEach((iface: NetworkInterfaceInfo) => {
              // Handle both IPv4 and IPv6 addresses
              if (!iface.internal) {
                if (iface.family === 'IPv4' || iface.family === '4') {
                  console.log(`  http://${iface.address}:${info.port}`);
                  processedUrls.add(`${iface.address}:${info.port}`);

                  // Try to get hostname from IP address
                  const lookupPromise = dns.promises.reverse(iface.address)
                    .then((hostnames: string[]) => {
                      if (hostnames && hostnames.length > 0) {
                        for (const hostname of hostnames) {
                          if (!processedUrls.has(`${hostname}:${info.port}`)) {
                            console.log(`  http://${hostname}:${info.port}`);
                            processedUrls.add(`${hostname}:${info.port}`);
                          }
                        }
                      }
                    })
                    .catch(() => {
                      // Silently ignore DNS errors
                    });

                  promises.push(lookupPromise);
                } else if ((iface.family === 'IPv6' || iface.family === '6') && showIPv6) {
                  // Only show IPv6 addresses if they should be shown
                  // For IPv6, add brackets around the address in the URL
                  console.log(`  http://[${iface.address}]:${info.port}`);
                  processedUrls.add(`[${iface.address}]:${info.port}`);

                  // Add special handling for well-known IPv6 addresses
                  if (isSpecialIPv6(iface.address)) {
                    if (iface.address === '::1') {
                      console.log(`  http://localhost:${info.port} (IPv6)`);
                    } else if (iface.address.startsWith('fe80:')) {
                      // For link-local addresses, suggest using scope id if available
                      if (iface.scopeid !== undefined) {
                        console.log(`  http://[${iface.address}%${iface.scopeid}]:${info.port} (link-local)`);
                      }
                    }
                  }

                  // IPv6 reverse DNS lookup 
                  const lookupPromise = dns.promises.reverse(iface.address)
                    .then((hostnames: string[]) => {
                      if (hostnames && hostnames.length > 0) {
                        for (const hostname of hostnames) {
                          if (!processedUrls.has(`${hostname}:${info.port}`)) {
                            console.log(`  http://${hostname}:${info.port}`);
                            processedUrls.add(`${hostname}:${info.port}`);
                          }
                        }
                      }
                    })
                    .catch(() => {
                      // Silently ignore DNS errors
                    });

                  promises.push(lookupPromise);
                }
              }
            });
          }
        });

        // Add hostname-based URL
        try {
          const hostnameStr = osHostname();
          if (hostnameStr && !processedUrls.has(`${hostnameStr}:${info.port}`)) {
            console.log(`  http://${hostnameStr}:${info.port}`);
            processedUrls.add(`${hostnameStr}:${info.port}`);
          }
        } catch (err) {
          // Silently ignore hostname resolution errors
        }
      } else if (bind === '127.0.0.1') {
        // 127.0.0.1 is an IPv4 address, so IPv6 is disabled
        console.log(`CAME+test running at http://${info.address}:${info.port}`);
        console.log(`                  or http://localhost:${info.port}`);
      } else if (bind === '::1') {
        // Only run with IPv6 localhost binding if IPv6 is enabled
        if (!ipv6Enabled) {
          console.error('Error: Cannot bind to IPv6 localhost (::1) because IPv6 is not enabled on this system.');
          process.exit(1);
        }

        // Special handling for IPv6 localhost
        console.log(`CAME+test running at http://[${info.address}]:${info.port}`);
        console.log(`                  or http://localhost:${info.port} (IPv6)`);
      } else {
        // Use DNS promises API for reverse lookup
        const processedUrls = new Set<string>();

        console.log(`CAME+test running at http://${info.address}:${info.port}`);
        processedUrls.add(`${info.address}:${info.port}`);

        // Check if this is an IPv4 address binding (IPv6 should be disabled)
        if (isIPv4Address(bind)) {
          // For IPv4 specific binding, don't show any IPv6 addresses
          console.log(`(IPv6 is disabled when binding to IPv4 address ${bind})`);
        }
        // Add IPv6 format URL if the bind address appears to be IPv6
        else if (bind.includes(':')) {
          // Verify IPv6 is enabled if trying to bind to an IPv6 address
          if (!ipv6Enabled) {
            console.error('Error: Cannot bind to IPv6 address because IPv6 is not enabled on this system.');
            process.exit(1);
          }

          console.log(`                  or http://[${info.address}]:${info.port}`);
          processedUrls.add(`[${info.address}]:${info.port}`);

          // Special handling for link-local addresses which require scope ID
          if (bind.startsWith('fe80:')) {
            console.log(`  Note: Link-local IPv6 addresses may require a scope ID in some browsers.`);
            console.log(`  Try http://[${info.address}%<scope_id>]:${info.port} if direct access fails.`);
          }
        }

        // Try reverse DNS lookup for the bound IP
        dns.promises.reverse(info.address)
          .then((hostnames: string[]) => {
            if (hostnames && hostnames.length > 0) {
              for (const hostname of hostnames) {
                if (!processedUrls.has(`${hostname}:${info.port}`)) {
                  console.log(`                  or http://${hostname}:${info.port}`);
                  processedUrls.add(`${hostname}:${info.port}`);
                }
              }
            }
          })
          .catch(() => {
            // Silently ignore DNS errors
          });

        // Try to get system hostname
        try {
          const hostnameStr = osHostname();
          if (hostnameStr && !processedUrls.has(`${hostnameStr}:${info.port}`)) {
            console.log(`                  or http://${hostnameStr}:${info.port}`);
            processedUrls.add(`${hostnameStr}:${info.port}`);
          }
        } catch (err) {
          // Silently ignore hostname resolution errors
        }
      }
    }
  );
}

// Function to install as a Windows service
function installWindowsService(port: number, bind: string, ipv6: boolean): void {
  console.log(`Installing ${pkg.name} as a Windows service came-plus-test...`);

  try {
    // Check if running with admin privileges (required for service installation)
    try {
      execSync('net session', { stdio: 'ignore' });
    } catch {
      console.error('Error: Administrator privileges are required to install a Windows service.');
      console.error('Please run the command again with administrator privileges.');
      process.exit(1);
    }

    // Create service configuration
    const nodePath = process.execPath; // Path to node executable
    const serviceName = 'came-plus-test';
    const serviceDisplayName = 'CAME+test';
    const serviceDescription = `${pkg.description} (v${pkg.version})`;

    // Build service command with provided parameters
    let serviceParams = '';
    if (port !== 64001) {
      serviceParams += ` --port=${port}`;
    }
    if (bind !== '0.0.0.0') {
      serviceParams += ` --bind=${bind}`;
    }
    if (ipv6) {
      serviceParams += ' --ipv6';
    }

    // Check if nssm is available (Service Manager for Windows)
    try {
      execSync('where nssm', { stdio: 'ignore' });

      // If nssm is available, use it (it's more feature-rich)
      console.log('Using NSSM to install service...');
      execSync(`nssm install ${serviceName} "${nodePath}"`, { stdio: 'inherit' });
      execSync(`nssm set ${serviceName} AppParameters "${__filename}${serviceParams}"`, { stdio: 'inherit' });
      execSync(`nssm set ${serviceName} DisplayName "${serviceDisplayName}"`, { stdio: 'inherit' });
      execSync(`nssm set ${serviceName} Description "${serviceDescription}"`, { stdio: 'inherit' });
      execSync(`nssm set ${serviceName} AppDirectory "${dirname(__filename)}"`, { stdio: 'inherit' });
      execSync(`nssm set ${serviceName} Start SERVICE_AUTO_START`, { stdio: 'inherit' });
      console.log(`Service ${serviceDisplayName} installed successfully.`);
      console.log('Starting service...');
      execSync(`nssm start ${serviceName}`, { stdio: 'inherit' });
      console.log('Service started successfully.');

    } catch {
      console.log('NSSM (Non-Sucking Service Manager) is not found. Installing service using Windows SC command...');

      // For native Windows service, we need to create a Windows-service compatible executable
      // Create a directory for the service files
      const serviceDir = join(process.env.ProgramData || 'C:\\ProgramData', 'came-plus-test');
      mkdirSync(serviceDir, { recursive: true });

      // Create a VBScript wrapper that can properly run as a Windows service
      const vbsFilePath = join(serviceDir, 'service_wrapper.vbs');
      const vbsContent = `
' Windows Service VBScript Wrapper for Node.js
' This script is designed to start a Node.js process as a Windows service

Option Explicit
Dim shell, nodeProcess, nodeCommand, fso, logFile

' Set up file system object
Set fso = CreateObject("Scripting.FileSystemObject")
Set logFile = fso.OpenTextFile("${serviceDir.replace(/\\/g, "\\\\")}\\service.log", 8, True)

' Log startup
logFile.WriteLine(Date & " " & Time & " - Service wrapper script starting")

' Set the command to run Node.js
nodeCommand = "${nodePath.replace(/\\/g, "\\\\")}" & " " & "${__filename.replace(/\\/g, "\\\\")}${serviceParams}"
logFile.WriteLine("Command: " & nodeCommand)

' Create shell object
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "${dirname(__filename).replace(/\\/g, "\\\\")}"

' Set environment variables
shell.Environment("PROCESS")("NODE_PATH") = shell.Environment("PROCESS")("APPDATA") & "\\\\npm\\\\node_modules"

' Log before starting
logFile.WriteLine(Date & " " & Time & " - Starting Node.js process")

' Run the Node.js process hidden (0 = hidden)
Set nodeProcess = shell.Exec(nodeCommand)

' Log process ID
logFile.WriteLine("Process started with ID: " & nodeProcess.ProcessID)
logFile.WriteLine(Date & " " & Time & " - Service wrapper script completed initialization")
logFile.Close

' Exit - but keep the process running in background
`;

      // Create a batch file launcher for the VBScript (for service to call)
      const batchFilePath = join(serviceDir, 'start_service.bat');
      const batchContent = `@echo off
wscript.exe "${vbsFilePath.replace(/\\/g, "\\")}" 
exit /b 0
`;

      try {
        writeFileSync(vbsFilePath, vbsContent, 'utf8');
        writeFileSync(batchFilePath, batchContent, 'utf8');
        console.log(`Created service files at: ${serviceDir}`);

        // Install using Windows Service Controller (sc.exe)
        execSync(`sc create ${serviceName} binPath= "${batchFilePath}" start= auto DisplayName= "${serviceDisplayName}"`, { stdio: 'inherit' });
        execSync(`sc description ${serviceName} "${serviceDescription}"`, { stdio: 'inherit' });

        // Set service configuration to handle delays and recovery
        execSync(`sc config ${serviceName} type= own`, { stdio: 'inherit' });
        execSync(`sc failure ${serviceName} reset= 86400 actions= restart/60000/restart/60000/restart/60000`, { stdio: 'inherit' });

        console.log(`Service ${serviceDisplayName} installed successfully.`);
        console.log('Starting service...');

        try {
          execSync(`sc start ${serviceName}`, { stdio: 'inherit' });
          console.log('Service started successfully.');
        } catch (startError) {
          console.log('Warning: Service created but could not be started automatically.');
          console.log('You can start it manually from the Services management console.');
          console.log(`The service "${serviceDisplayName}" will start automatically on system boot.`);
        }
      } catch (err) {
        console.error('Error creating service files:', err);
        process.exit(1);
      }
    }
  } catch (error) {
    console.error('Failed to install Windows service:', error);
    process.exit(1);
  }
}

// Function to install service based on platform
function installService(port: number, bind: string, ipv6: boolean): void {
  const platform = process.platform;

  switch (platform) {
    case 'win32':
      installWindowsService(port, bind, ipv6);
      break;
    case 'linux':
      console.log('Linux service installation not yet implemented. Coming soon!');
      console.log('For now, you can create a systemd service manually.');
      break;
    case 'darwin':
      console.log('macOS service installation not yet implemented. Coming soon!');
      console.log('For now, you can create a launchd service manually.');
      break;
    default:
      console.error(`Service installation not supported on ${platform} platform.`);
      process.exit(1);
  }
}

// Function to uninstall Windows service
function uninstallWindowsService(): void {
  console.log(`Uninstalling ${pkg.name} Windows service came-plus-test...`);

  try {
    // Check if running with admin privileges (required for service uninstallation)
    try {
      execSync('net session', { stdio: 'ignore' });
    } catch {
      console.error('Error: Administrator privileges are required to uninstall a Windows service.');
      console.error('Please run the command again with administrator privileges.');
      process.exit(1);
    }

    const serviceName = 'came-plus-test';

    // Check if service exists before attempting to uninstall
    try {
      execSync(`sc query ${serviceName}`, { stdio: 'ignore' });
    } catch {
      console.error(`Error: Service '${serviceName}' is not installed.`);
      process.exit(1);
    }

    // Check if nssm is available (Service Manager for Windows)
    let usingNssm = false;
    try {
      execSync('where nssm', { stdio: 'ignore' });
      usingNssm = true;
    } catch {
      // Will use native SC commands if NSSM is not available
    }

    console.log(`Stopping the ${serviceName} service...`);

    // Stop the service first - don't error if already stopped
    try {
      if (usingNssm) {
        execSync(`nssm stop ${serviceName}`, { stdio: 'inherit' });
      } else {
        execSync(`sc stop ${serviceName}`, { stdio: 'inherit' });
      }
    } catch {
      console.log('Service was not running.');
    }

    // Remove the service
    if (usingNssm) {
      console.log('Using NSSM to remove service...');
      execSync(`nssm remove ${serviceName} confirm`, { stdio: 'inherit' });
    } else {
      console.log('Using SC to remove service...');
      execSync(`sc delete ${serviceName}`, { stdio: 'inherit' });
    }

    // Clean up any service files
    try {
      const serviceDir = join(process.env.ProgramData || 'C:\\ProgramData', 'came-plus-test');
      console.log(`Removing service files from ${serviceDir}...`);
      // Note: recursive deletion would require additional functionality
      // For now, just indicate that files should be removed manually if needed
      console.log(`If needed, you can manually delete ${serviceDir}`);
    } catch (error) {
      console.log('Warning: Could not access service directory for cleanup.');
    }

    console.log(`Service ${serviceName} successfully uninstalled.`);
  } catch (error) {
    console.error('Failed to uninstall Windows service:', error);
    process.exit(1);
  }
}

// Function to uninstall service based on platform
function uninstallService(): void {
  const platform = process.platform;

  switch (platform) {
    case 'win32':
      uninstallWindowsService();
      break;
    case 'linux':
      console.log('Linux service uninstallation not yet implemented. Coming soon!');
      console.log('For now, you can remove systemd services manually.');
      break;
    case 'darwin':
      console.log('macOS service uninstallation not yet implemented. Coming soon!');
      console.log('For now, you can remove launchd services manually.');
      break;
    default:
      console.error(`Service uninstallation not supported on ${platform} platform.`);
      process.exit(1);
  }
}