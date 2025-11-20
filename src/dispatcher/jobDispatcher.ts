import { Database } from '../database/mongodb';
import { Config } from '../config/config';

export class JobDispatcher {
  private database: Database;
  private config: Config;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private currentEncoderIndex = 0;

  constructor(database: Database, config: Config) {
    this.database = database;
    this.config = config;
  }

  /**
   * Get next encoder using round-robin
   */
  private getNextEncoder() {
    const enabledEncoders = this.config.encoders.filter(e => e.enabled);
    
    if (enabledEncoders.length === 0) {
      throw new Error('No enabled encoders available');
    }
    
    const encoder = enabledEncoders[this.currentEncoderIndex % enabledEncoders.length];
    this.currentEncoderIndex++;
    
    return encoder;
  }

  /**
   * Start the dispatcher polling loop
   */
  start(intervalSeconds: number = 30): void {
    if (this.isRunning) {
      console.log('Dispatcher already running');
      return;
    }

    this.isRunning = true;
    console.log(`Starting job dispatcher (polling every ${intervalSeconds}s)`);

    // Run immediately, then on interval
    this.processJobs();
    this.intervalId = setInterval(() => this.processJobs(), intervalSeconds * 1000);
  }

  /**
   * Stop the dispatcher polling loop
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.isRunning = false;
      console.log('Job dispatcher stopped');
    }
  }

  /**
   * Process pending jobs
   */
  private async processJobs(): Promise<void> {
    try {
      const pendingJobs = await this.database.getPendingJobs(5);

      if (pendingJobs.length === 0) {
        return; // No jobs to process
      }

      console.log(`Found ${pendingJobs.length} pending job(s)`);

      for (const job of pendingJobs) {
        try {
          await this.dispatchJob(job.owner, job.permlink);
        } catch (error) {
          console.error(`Failed to dispatch job ${job.owner}/${job.permlink}:`, error);
          
          // Increment attempt count and set error
          await this.database.incrementJobAttempt(job.owner, job.permlink);
          await this.database.updateJobStatus(job.owner, job.permlink, 'pending', {
            lastError: error instanceof Error ? error.message : String(error),
          });

          // If too many attempts, mark as failed
          if (job.attemptCount >= 3) {
            await this.database.updateJobStatus(job.owner, job.permlink, 'failed', {
              lastError: `Max attempts exceeded: ${error instanceof Error ? error.message : String(error)}`,
            });
            await this.database.updateVideoStatus(job.permlink, 'failed');
            console.error(`Job ${job.owner}/${job.permlink} failed after ${job.attemptCount} attempts`);
          }
        }
      }
    } catch (error) {
      console.error('Error processing jobs:', error);
    }
  }

  /**
   * Dispatch a single job to the encoder
   */
  private async dispatchJob(owner: string, permlink: string): Promise<void> {
    // Get video metadata
    const video = await this.database.getVideo(permlink);
    if (!video) {
      throw new Error(`Video not found: ${permlink}`);
    }

    if (!video.input_cid) {
      throw new Error(`Video has no input_cid: ${permlink}`);
    }

    // Prepare encoder request with full IPFS gateway URL
    const ipfsGateway = 'https://ipfs.3speak.tv/ipfs';
    const encoderRequest = {
      owner,
      permlink,
      input_cid: `${ipfsGateway}/${video.input_cid}`,
      short: video.short,
      webhook_url: this.config.webhookUrl,
      api_key: this.config.webhookApiKey,
      frontend_app: video.frontend_app,
      originalFilename: video.originalFilename,
    };

    // Select encoder using round-robin
    const encoder = this.getNextEncoder();
    console.log(`Dispatching job to encoder [${encoder.name}]: ${owner}/${permlink}`);
    console.log(`Encoder request payload:`, JSON.stringify(encoderRequest, null, 2));

    // Call encoder API
    const response = await fetch(`${encoder.url}/encode`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': encoder.apiKey,
      },
      body: JSON.stringify(encoderRequest),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Encoder API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json() as { job_id: string; encoder_id?: string };
    console.log(`Job dispatched successfully to [${encoder.name}]: ${result.job_id}`);

    // Update job status to encoding
    await this.database.updateJobStatus(owner, permlink, 'encoding', {
      encoderJobId: result.job_id,
      assignedWorker: encoder.name,
      assignedAt: new Date(),
    });
  }
}
