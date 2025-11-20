export interface EncoderConfig {
  name: string;
  url: string;
  apiKey: string;
  enabled: boolean;
}

export interface Config {
  port: number;
  mongoUri: string;
  mongoDbName: string;
  mongoCollectionVideos: string;
  mongoCollectionUsers: string;
  mongoCollectionKeys: string;
  mongoCollectionJobs: string;
  uploadDir: string;
  baseUrl: string;
  demoApiKey: string;
  adminPassword: string;
  ipfsApiAddr: string;
  ipfsSupernodeEndpoint: string;
  encoders: EncoderConfig[];
  webhookApiKey: string;
  webhookUrl: string;
}

function parseEncoders(): EncoderConfig[] {
  const encoders: EncoderConfig[] = [];
  
  // Parse ENCODERS environment variable (JSON array format)
  // Example: [{"name":"snapie","url":"https://snapie.3speak.tv","apiKey":"key1","enabled":true}]
  const encodersJson = process.env.ENCODERS;
  if (encodersJson) {
    try {
      const parsed = JSON.parse(encodersJson) as EncoderConfig[];
      encoders.push(...parsed.filter(e => e.enabled));
    } catch (error) {
      console.error('Failed to parse ENCODERS env variable:', error);
    }
  }
  
  // Fallback: legacy single encoder config
  if (encoders.length === 0 && process.env.ENCODER_API_URL && process.env.ENCODER_API_KEY) {
    encoders.push({
      name: 'default',
      url: process.env.ENCODER_API_URL,
      apiKey: process.env.ENCODER_API_KEY,
      enabled: true,
    });
  }
  
  return encoders;
}

export function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    mongoUri: process.env.MONGODB_URI || '',
    mongoDbName: process.env.MONGODB_DATABASE || 'threespeak',
    mongoCollectionVideos: process.env.MONGODB_COLLECTION_VIDEOS || 'embed-video',
    mongoCollectionUsers: process.env.MONGODB_COLLECTION_USERS || 'embed-users',
    mongoCollectionKeys: process.env.MONGODB_COLLECTION_KEYS || 'embed-api-keys',
    mongoCollectionJobs: process.env.MONGODB_COLLECTION_JOBS || 'embed-jobs',
    uploadDir: process.env.UPLOAD_DIR || './uploads',
    baseUrl: process.env.BASE_URL || 'https://play.3speak.tv/embed',
    demoApiKey: process.env.DEMO_API_KEY || 'sk_demo_b0d3f4b972c5065b701394df3de2f44fd59aa3244c58c478',
    adminPassword: process.env.ADMIN_PASSWORD || 'change-me-in-production',
    ipfsApiAddr: process.env.IPFS_API_ADDR || '/ip4/127.0.0.1/tcp/5001',
    ipfsSupernodeEndpoint: process.env.THREESPEAK_IPFS_ENDPOINT || 'http://65.21.201.94:5002',
    encoders: parseEncoders(),
    webhookApiKey: process.env.WEBHOOK_API_KEY || '',
    webhookUrl: process.env.WEBHOOK_URL || '',
  };
}
