import { MongoClient, Db, Collection } from 'mongodb';

export type VideoStatus = 'uploading' | 'processing' | 'published' | 'failed' | 'deleted';

export interface VideoMetadata {
  owner: string;
  permlink: string;
  frontend_app: string;
  status: VideoStatus;
  input_cid: string | null;
  manifest_cid: string | null;
  thumbnail_url: string | null;
  short: boolean;
  duration: number | null;
  size: number | null;
  encodingProgress: number;
  originalFilename: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface User {
  username: string;
  banned: boolean;
  banReason: string | null;
  bannedAt: Date | null;
  bannedBy: string | null;
  uploadRestricted: boolean;
  maxDailyUploads: number | null;
  maxFileSize: number | null;
  stats: {
    totalUploads: number;
    totalStorageUsed: number;
    successfulUploads: number;
    failedUploads: number;
    lastUpload: Date | null;
  };
  trustLevel: 'new' | 'trusted' | 'verified' | 'restricted';
  adminNotes: string;
  firstSeen: Date;
  lastActivity: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiKey {
  key: string;
  app_name: string;
  owner: string;
  active: boolean;
  createdAt: Date;
  lastUsed: Date | null;
}

export type JobStatus = 'pending' | 'encoding' | 'completed' | 'failed';

export interface EncodingJob {
  owner: string;
  permlink: string;
  status: JobStatus;
  assignedWorker: string | null;
  encoderJobId: string | null;
  assignedAt: Date | null;
  attemptCount: number;
  lastError: string | null;
  webhookReceivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class Database {
  private client: MongoClient;
  private db: Db | null = null;
  private collection: Collection<VideoMetadata> | null = null;

  constructor(connectionString: string, dbName: string, collectionName: string) {
    this.client = new MongoClient(connectionString);
  }

  async connect(dbName: string, collectionName: string): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(dbName);
    this.collection = this.db.collection<VideoMetadata>(collectionName);
    console.log('Connected to MongoDB');
  }

  async createVideoEntry(metadata: VideoMetadata): Promise<void> {
    if (!this.collection) {
      throw new Error('Database not connected');
    }
    await this.collection.insertOne(metadata);
  }

  async updateVideoStatus(
    permlink: string,
    status: VideoStatus,
    additionalData?: Partial<VideoMetadata>
  ): Promise<void> {
    if (!this.collection) {
      throw new Error('Database not connected');
    }
    await this.collection.updateOne(
      { permlink },
      { $set: { status, updatedAt: new Date(), ...additionalData } }
    );
  }

  async getVideo(permlink: string): Promise<VideoMetadata | null> {
    if (!this.collection) {
      throw new Error('Database not connected');
    }
    return this.collection.findOne({ permlink });
  }

  async getStaleUploads(hoursOld: number): Promise<VideoMetadata[]> {
    if (!this.collection) {
      throw new Error('Database not connected');
    }
    const cutoffDate = new Date(Date.now() - hoursOld * 60 * 60 * 1000);
    return this.collection.find({
      status: 'uploading',
      createdAt: { $lt: cutoffDate }
    }).toArray();
  }

  async getStaleProcessing(hoursOld: number): Promise<VideoMetadata[]> {
    if (!this.collection) {
      throw new Error('Database not connected');
    }
    const cutoffDate = new Date(Date.now() - hoursOld * 60 * 60 * 1000);
    return this.collection.find({
      status: 'processing',
      updatedAt: { $lt: cutoffDate }
    }).toArray();
  }

  // API Key Management Methods
  async createApiKey(apiKey: ApiKey): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const keysCollection = this.db.collection<ApiKey>('embed-api-keys');
    await keysCollection.insertOne(apiKey);
  }

  async getApiKey(key: string): Promise<ApiKey | null> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const keysCollection = this.db.collection<ApiKey>('embed-api-keys');
    return keysCollection.findOne({ key });
  }

  async getAllApiKeys(): Promise<ApiKey[]> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const keysCollection = this.db.collection<ApiKey>('embed-api-keys');
    return keysCollection.find({}).sort({ createdAt: -1 }).toArray();
  }

  async updateApiKeyStatus(key: string, active: boolean): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const keysCollection = this.db.collection<ApiKey>('embed-api-keys');
    await keysCollection.updateOne({ key }, { $set: { active } });
  }

  async updateApiKeyLastUsed(key: string): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const keysCollection = this.db.collection<ApiKey>('embed-api-keys');
    await keysCollection.updateOne({ key }, { $set: { lastUsed: new Date() } });
  }

  // Encoding Job Management Methods
  async createJob(job: EncodingJob): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const jobsCollection = this.db.collection<EncodingJob>('embed-jobs');
    
    // Ensure unique compound index exists
    await jobsCollection.createIndex({ owner: 1, permlink: 1 }, { unique: true });
    
    await jobsCollection.insertOne(job);
  }

  async getJob(owner: string, permlink: string): Promise<EncodingJob | null> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const jobsCollection = this.db.collection<EncodingJob>('embed-jobs');
    return jobsCollection.findOne({ owner, permlink });
  }

  async getPendingJobs(limit: number = 10): Promise<EncodingJob[]> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const jobsCollection = this.db.collection<EncodingJob>('embed-jobs');
    return jobsCollection
      .find({ status: 'pending' })
      .sort({ createdAt: 1 })
      .limit(limit)
      .toArray();
  }

  async updateJobStatus(
    owner: string,
    permlink: string,
    status: JobStatus,
    additionalData?: Partial<EncodingJob>
  ): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const jobsCollection = this.db.collection<EncodingJob>('embed-jobs');
    await jobsCollection.updateOne(
      { owner, permlink },
      { $set: { status, updatedAt: new Date(), ...additionalData } }
    );
  }

  async incrementJobAttempt(owner: string, permlink: string): Promise<void> {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    const jobsCollection = this.db.collection<EncodingJob>('embed-jobs');
    await jobsCollection.updateOne(
      { owner, permlink },
      { $inc: { attemptCount: 1 }, $set: { updatedAt: new Date() } }
    );
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
