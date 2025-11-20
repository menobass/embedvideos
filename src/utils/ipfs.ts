import { createReadStream } from 'fs';
import { loadConfig } from '../config/config';
import FormData from 'form-data';
import http from 'http';
import https from 'https';

const config = loadConfig();

/**
 * Pin a file to IPFS using local daemon first, fallback to supernode
 * @param filePath Absolute path to the file to pin
 * @returns IPFS CID of the pinned file
 */
export async function pinFile(filePath: string): Promise<string> {
  // Try local daemon first
  try {
    console.log(`Attempting to pin to local IPFS daemon: http://127.0.0.1:5001`);
    const cid = await addToIpfs('http://127.0.0.1:5001', filePath);
    console.log(`Successfully pinned to local daemon: ${cid}`);
    return cid;
  } catch (localError) {
    console.warn(`Local IPFS daemon failed: ${localError}`);
    console.log(`Falling back to supernode: ${config.ipfsSupernodeEndpoint}`);
    
    // Fallback to supernode
    try {
      const cid = await addToIpfs(config.ipfsSupernodeEndpoint, filePath);
      console.log(`Successfully pinned to supernode: ${cid}`);
      return cid;
    } catch (supernodeError) {
      console.error(`Supernode IPFS failed: ${supernodeError}`);
      throw new Error(`Failed to pin file to IPFS: ${supernodeError}`);
    }
  }
}

async function addToIpfs(apiUrl: string, filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', createReadStream(filePath));
    
    const url = new URL(`${apiUrl}/api/v0/add?pin=true`);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;
    
    const req = client.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: formData.getHeaders(),
    }, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error(`IPFS API error response: ${data}`);
          reject(new Error(`IPFS API error: ${res.statusCode} ${res.statusMessage}`));
          return;
        }
        
        try {
          const result = JSON.parse(data) as { Hash: string };
          resolve(result.Hash);
        } catch (error) {
          reject(new Error(`Failed to parse IPFS response: ${error}`));
        }
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    formData.pipe(req);
  });
}
