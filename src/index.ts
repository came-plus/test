#!/usr/bin/env node

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { networkInterfaces, hostname as osHostname } from 'os';
import * as dns from 'dns';
import { execSync, spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const pkgPath = resolve(__dirname, '../package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

// Function to display help/usage information
function showHelp(): void {
  console.log(`
${pkg.name} v${pkg.version}
${pkg.description}

USAGE:
  npx "@came.plus/test" [OPTIONS]
  npx "@came.plus/test" install [OPTIONS]

OPTIONS:
  --help                 Show this help message and exit
  --version              Show version information and exit
  --port=NUMBER          Set the port to listen on (default: 64001)
  --bind=ADDRESS         Set the address to bind to (default: 0.0.0.0)
  --ipv6                 Use IPv6 dual-stack mode (bind to ::)

COMMANDS:
  install                Install as a system service (requires admin/root privileges)

EXAMPLES:
  npx "@came.plus/test"                      # Start with default settings (port 64001, all IPv4 interfaces)
  npx "@came.plus/test" --port=8080          # Start on port 8080
  npx "@came.plus/test" --bind=127.0.0.1     # Only listen on localhost
  npx "@came.plus/test" --ipv6               # Enable IPv6 dual-stack mode
  npx "@came.plus/test" install              # Install as a system service with default settings
  npx "@came.plus/test" install --port=8080  # Install as a system service on port 8080
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

// Start server
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
      
      console.log(`CAME+test version: ${pkg.version}`);
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

// Function to install as a Windows service
function installWindowsService(port: number, bind: string, ipv6: boolean): void {
  console.log(`Installing ${pkg.name} as a Windows service...`);
  
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
    let serviceCommand = `"${nodePath}" "${__filename}"`;
    if (port !== 64001) {
      serviceCommand += ` --port=${port}`;
    }
    if (bind !== '0.0.0.0') {
      serviceCommand += ` --bind=${bind}`;
    }
    if (ipv6) {
      serviceCommand += ' --ipv6';
    }
    
    // Check if nssm is available (Service Manager for Windows)
    try {
      execSync('where nssm', { stdio: 'ignore' });
      
      // If nssm is available, use it (it's more feature-rich)
      console.log('Using NSSM to install service...');
      execSync(`nssm install ${serviceName} ${serviceCommand}`, { stdio: 'inherit' });
      execSync(`nssm set ${serviceName} DisplayName "${serviceDisplayName}"`, { stdio: 'inherit' });
      execSync(`nssm set ${serviceName} Description "${serviceDescription}"`, { stdio: 'inherit' });
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
      
      // Create a more robust batch file that handles Windows service requirements
      const batchFilePath = join(serviceDir, 'start_service.bat');
      
      // Generate a proper Windows service batch file
      const batchContent = `@echo off
:: Set working directory to the script location
cd /d "%~dp0"

:: Set NODE_PATH to include global modules
set NODE_PATH=%APPDATA%\\npm\\node_modules

:: Log startup for debugging
echo %DATE% %TIME% - Service starting > "%~dp0service.log"
echo Command: ${serviceCommand} >> "%~dp0service.log"

:: Run the node process
${serviceCommand} >> "%~dp0service.log" 2>&1
`;
      
      try {
        writeFileSync(batchFilePath, batchContent, 'utf8');
        console.log(`Created batch file at: ${batchFilePath}`);
        
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