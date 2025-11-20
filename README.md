# 3Speak Embed Video Upload Service

A modern, scalable video upload and encoding service with TUS resumable uploads, IPFS storage, multi-encoder support, and MongoDB job tracking. Built for the 3Speak decentralized video platform.

## Features

- **TUS Resumable Uploads**: Robust video uploads with pause/resume support
- **Instant Embed URLs**: Get playable embed URLs immediately upon upload start
- **IPFS Storage**: Automatic pinning to IPFS (local daemon + supernode fallback)
- **Multi-Encoder Support**: Round-robin load balancing across multiple encoder nodes
- **Job Dispatcher**: Automatic job queuing and distribution to available encoders
- **Webhook Callbacks**: Secure encoder-to-service communication for status updates
- **MongoDB Integration**: Tracks videos, jobs, and API keys
- **API Key Management**: Secure admin panel for managing application access
- **RESTful API**: Simple endpoints for video metadata and management

## Prerequisites

- Node.js v20 or higher
- MongoDB 6.0+
- IPFS daemon (for local pinning) or access to IPFS gateway
- npm or yarn
- One or more encoder nodes (see [3speak-encoder](https://github.com/your-repo))

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd 3speakembed
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file based on `.env.example`:
```bash
cp .env.example .env
```

4. Configure your environment variables in `.env` (see `.env.example` for full details):
```env
PORT=3001
MONGODB_URI=mongodb://user:pass@host:27017/threespeak
ENCODERS=[{"name":"encoder1","url":"https://encoder.example.com","apiKey":"key","enabled":true}]
WEBHOOK_API_KEY=your-secure-webhook-key
WEBHOOK_URL=https://embed.3speak.tv/webhook
```

See [.env.example](./.env.example) for complete configuration options.

## Usage

### Development Mode

```bash
npm run dev
```

### Production Mode

1. Build the project:
```bash
npm run build
```

2. Start the server:
```bash
npm start
```

## API Endpoints

### Health Check
```
GET /health
```
Returns the service status.

### Get Video Metadata
```
GET /video/:videoId
```
Retrieves metadata for a specific video.

### TUS Upload Endpoint
```
POST /uploads
```
TUS protocol endpoint for video uploads.

**Required Metadata:**
- `owner` or `username`: The username for the video owner
- `frontend_app`: Frontend application identifier (for tracking and billing)
- `short`: String `"true"` or `"false"` - whether this is a short-form video
- `filename`: (optional) Original filename

**Response Headers:**
- `X-Embed-URL`: The embed URL for the video (format: `https://play.3speak.tv/embed?v={owner}/{permlink}`)

## Upload Example

Using the TUS JavaScript client:

```javascript
import * as tus from 'tus-js-client';

const file = document.getElementById('file-input').files[0];

const upload = new tus.Upload(file, {
  endpoint: 'http://localhost:3000/uploads',
  metadata: {
    filename: file.name,
    owner: 'chessfighter',
    frontend_app: 'my-video-app',  // Your app identifier
    short: 'false',  // 'true' for short-form videos
    filetype: file.type
  },
  onError: (error) => {
    console.error('Upload failed:', error);
  },
  onProgress: (bytesUploaded, bytesTotal) => {
    const percentage = (bytesUploaded / bytesTotal * 100).toFixed(2);
    console.log(`Uploaded ${percentage}%`);
  },
  onSuccess: () => {
    console.log('Upload completed!');
  },
  onAfterResponse: (req, res) => {
    // Get the embed URL from response headers
    const embedUrl = res.getHeader('X-Embed-URL');
    console.log('Embed URL:', embedUrl);
    // Example: https://play.3speak.tv/embed?v=chessfighter/yn77aj9g
  }
});

upload.start();
```

## Project Structure

```
3speakembed/
├── src/
│   ├── config/
│   │   └── config.ts          # Configuration loader with multi-encoder support
│   ├── database/
│   │   └── mongodb.ts         # MongoDB connection and operations
│   ├── dispatcher/
│   │   └── jobDispatcher.ts   # Job queue manager with round-robin load balancing
│   ├── middleware/
│   │   ├── auth.ts            # API key validation middleware
│   │   └── adminAuth.ts       # Admin password middleware
│   ├── utils/
│   │   ├── videoId.ts         # Video ID generator
│   │   ├── keyGenerator.ts    # API key generator
│   │   └── ipfs.ts            # IPFS pinning utilities
│   └── index.ts               # Main server file
├── public/
│   ├── index.html             # Landing page with integration docs
│   ├── demo.html              # Upload demo interface
│   └── admin.html             # API key management panel
├── scripts/
│   ├── dropOldIndex.ts        # Database maintenance utilities
│   └── testEncoder.ts         # Encoder testing script
├── uploads/                   # TUS upload storage directory
├── .env.example               # Environment variables template
├── .gitignore
├── package.json
├── tsconfig.json
├── ENCODERS.md                # Multi-encoder configuration guide
└── README.md
```

## Data Schemas

### VideoMetadata

```typescript
interface VideoMetadata {
  owner: string;                // Username
  permlink: string;             // Random 8-character ID
  frontend_app: string;         // Frontend application identifier
  status: 'uploading' | 'processing' | 'published' | 'failed' | 'deleted';
  input_cid: string | null;     // IPFS CID of uploaded file
  manifest_cid: string | null;  // IPFS CID of HLS manifest
  thumbnail_url: string | null; // Video thumbnail URL
  short: boolean;               // Is short-form video (≤60s, 480p max)
  duration: number | null;      // Video duration in seconds
  size: number | null;          // File size in bytes
  encodingProgress: number;     // Encoding progress (0-100)
  originalFilename: string | null; // Original filename
  createdAt: Date;              // Upload start timestamp
  updatedAt: Date;              // Last modification timestamp
}
```

### EncodingJob

```typescript
interface EncodingJob {
  owner: string;                // Video owner username
  permlink: string;             // Video ID
  status: 'pending' | 'encoding' | 'completed' | 'failed';
  input_cid: string;            // IPFS CID of source video
  encoder?: string;             // Assigned encoder name
  attempts: number;             // Retry counter (max 3)
  error?: string;               // Error message if failed
  manifest_cid?: string;        // IPFS CID of output manifest
  thumbnail_url?: string;       // Generated thumbnail URL
  duration?: number;            // Video duration
  createdAt: Date;              // Job creation time
  updatedAt: Date;              // Last update time
}
```

### ApiKey

```typescript
interface ApiKey {
  key: string;                  // Hashed API key
  name: string;                 // Application name
  createdAt: Date;              // Creation timestamp
}
```

## Status Flow & Architecture

### Video Processing Pipeline

1. **Upload Start**: TUS creates video record with status `uploading`, returns embed URL immediately
2. **Upload Complete**: File pinned to IPFS, `input_cid` stored, encoding job created with status `pending`
3. **Job Dispatch**: Dispatcher picks up pending job, assigns to available encoder via round-robin, status becomes `encoding`
4. **Encoding**: Encoder processes video and calls webhook with results
5. **Webhook Update**: Video status set to `published`, `manifest_cid` and `thumbnail_url` stored, job marked `completed`
6. **Player Ready**: Embed URL now serves encoded HLS video

### Video Status States

- **uploading** - TUS upload in progress
- **processing** - Upload complete, encoder is working on it
- **published** - Video is ready to watch
- **failed** - Processing failed
- **deleted** - Video marked for deletion

The video player handles all these states automatically, showing appropriate animations for uploading/processing/failed states, making the embed URL usable immediately.

### Job Dispatcher

The dispatcher runs every 30 seconds:
1. Queries MongoDB for jobs with status `pending`
2. Selects next available encoder using round-robin algorithm
3. Sends job to encoder with IPFS gateway URL and webhook credentials
4. Updates job status to `encoding` with assigned encoder name
5. Retries failed jobs up to 3 times before marking as `failed`

See [ENCODERS.md](./ENCODERS.md) for multi-encoder configuration details.

## Embed URL Format

Videos are accessible via embed URLs in the following format:
```
https://play.3speak.tv/embed?v={username}/{videoId}
```

Example:
```
https://play.3speak.tv/embed?v=chessfighter/yn77aj9g
```

## License

MIT
