# Multi-Encoder Configuration

This service supports multiple encoder backends with automatic round-robin load balancing.

## Configuration

### Environment Variable Format

Configure encoders using the `ENCODERS` environment variable with a JSON array:

```bash
ENCODERS='[{"name":"snapie","url":"https://snapie.3speak.tv","apiKey":"ILFCPfX6l51CNQkHw","enabled":true},{"name":"eddie","url":"https://eddie-encoder.example.com","apiKey":"another-key-here","enabled":true}]'
```

### Encoder Object Schema

```typescript
{
  "name": string,      // Friendly name for logging (e.g., "snapie", "eddie")
  "url": string,       // Base URL of encoder API (e.g., "https://snapie.3speak.tv")
  "apiKey": string,    // API key for X-API-Key header
  "enabled": boolean   // Whether to use this encoder (false = skip)
}
```

## Load Balancing

The dispatcher uses **round-robin** load balancing:

- **1 encoder**: All jobs go to that encoder
- **2 encoders**: Jobs alternate: 1, 2, 1, 2, 1, 2...
- **3 encoders**: Jobs rotate: 1, 2, 3, 1, 2, 3...
- **N encoders**: Jobs cycle through all N encoders

### Example Flow

With 3 encoders (snapie, eddie, backup):

```
Job 1 → snapie
Job 2 → eddie
Job 3 → backup
Job 4 → snapie
Job 5 → eddie
Job 6 → backup
...
```

## Adding/Removing Encoders

### Add a New Encoder

1. Update `.env` with new encoder in the JSON array:
```bash
ENCODERS='[{"name":"snapie","url":"https://snapie.3speak.tv","apiKey":"key1","enabled":true},{"name":"new-encoder","url":"https://new.example.com","apiKey":"key2","enabled":true}]'
```

2. Restart the service:
```bash
npm run dev  # or your production restart command
```

3. Check logs to confirm it was loaded:
```
Encoders available (2):
  - snapie: https://snapie.3speak.tv
  - new-encoder: https://new.example.com
```

### Temporarily Disable an Encoder

Set `"enabled": false` without removing it:

```bash
ENCODERS='[{"name":"snapie","url":"https://snapie.3speak.tv","apiKey":"key1","enabled":true},{"name":"eddie","url":"https://eddie.example.com","apiKey":"key2","enabled":false}]'
```

Jobs will only go to `snapie` until you re-enable `eddie`.

### Remove an Encoder Permanently

Simply remove it from the JSON array and restart.

## Legacy Single-Encoder Support

For backward compatibility, if `ENCODERS` is not set, the service falls back to:

```bash
ENCODER_API_URL=https://snapie.3speak.tv
ENCODER_API_KEY=ILFCPfX6l51CNQkHw
```

This creates a single encoder named `"default"`.

## Monitoring

### Startup Logs

On startup, the service logs all available encoders:

```
Connected to MongoDB
Encoders available (3):
  - snapie: https://snapie.3speak.tv
  - eddie: https://eddie-encoder.example.com
  - backup: https://backup.example.com
Starting job dispatcher (polling every 30s)
Server running on port 3000
```

### Dispatch Logs

When dispatching jobs, logs show which encoder was selected:

```
Dispatching job to encoder [eddie]: alice/my-video
Job dispatched successfully to [eddie]: abc123-def456
```

### Job Database

The `embed-jobs` collection tracks which encoder handled each job:

```javascript
{
  owner: "alice",
  permlink: "my-video",
  status: "encoding",
  assignedWorker: "eddie",  // ← Shows which encoder
  encoderJobId: "abc123-def456",
  assignedAt: ISODate("2025-11-20T12:00:00Z")
}
```

## Error Handling

If an encoder fails:

1. Job attempt count increments
2. Error is logged in `lastError` field
3. Job remains `"pending"` for retry
4. After 3 failed attempts, job marked as `"failed"`

The dispatcher will try the **next** encoder in rotation on retry.

## Production Example

Three encoders for high availability:

```bash
# .env
ENCODERS='[
  {"name":"snapie-primary","url":"https://snapie.3speak.tv","apiKey":"key1","enabled":true},
  {"name":"eddie-secondary","url":"https://eddie.example.com","apiKey":"key2","enabled":true},
  {"name":"backup-encoder","url":"https://backup.example.com","apiKey":"key3","enabled":true}
]'
```

This distributes load evenly and provides redundancy if one encoder goes down.

## Notes

- JSON must be valid (use online validators if needed)
- Keys are sensitive - keep them secret
- Restart required after config changes
- Disabled encoders (`enabled: false`) are skipped in rotation
- Empty `ENCODERS` array falls back to legacy single-encoder config
