# Caremates

Offline-first PWA for audio recording. Records audio on any device, stores locally in IndexedDB, and syncs to AWS (S3 + DynamoDB) when connectivity is available.

## Tech Stack

- **Framework:** Next.js 16 with React 19 and React Compiler
- **Styling:** Tailwind CSS v4
- **API:** tRPC v11 with React Query
- **PWA:** Serwist (Service Worker toolkit, Workbox fork)
- **Storage:** IndexedDB (local), AWS S3 (audio files), AWS DynamoDB (metadata)
- **Infrastructure:** Pulumi (IaC), ECS Fargate, CloudFront, ALB
- **Containerization:** Docker (Node 20 Alpine, standalone output)

## Prerequisites

- Node.js 20+
- npm
- AWS credentials (for S3 and DynamoDB access)
- Pulumi CLI (for infrastructure deployment only)

## Environment Variables

Create a `.env` file based on `.env.example`:

```
CAREMATES_AWS_REGION=eu-north-1
CAREMATES_AWS_ACCESS_KEY_ID=<your-access-key>
CAREMATES_AWS_SECRET_ACCESS_KEY=<your-secret-key>
CAREMATES_AWS_S3_BUCKET=<your-s3-bucket-name>
CAREMATES_AWS_DYNAMODB_TABLE=<your-dynamodb-table-name>
```

| Variable | Description |
|---|---|
| `CAREMATES_AWS_REGION` | AWS region for S3 and DynamoDB |
| `CAREMATES_AWS_ACCESS_KEY_ID` | IAM access key with S3 + DynamoDB permissions |
| `CAREMATES_AWS_SECRET_ACCESS_KEY` | IAM secret key |
| `CAREMATES_AWS_S3_BUCKET` | S3 bucket name for audio file storage |
| `CAREMATES_AWS_DYNAMODB_TABLE` | DynamoDB table name for recording metadata |

## Getting Started (Development)

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

In development, the Service Worker is **disabled** (see `next.config.ts`). Uploads go directly from the page to the server — no offline retry, no background sync.

## Production
App available at https://d1cxlgnta8if7p.cloudfront.net

## Testing with the Service Worker

The Service Worker only runs in production builds. To test offline behavior, background sync, and upload retry:

```bash
npm run build
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

To simulate offline:
1. Open DevTools > Network tab > check "Offline"
2. Or disconnect from Wi-Fi/network

To verify the SW is active:
- Chrome: DevTools > Application > Service Workers
- Safari: Develop menu > Service Workers > select the SW (note: Safari shows SW logs in a **separate console**, not the page console)

### Browser-Specific Behavior

| Feature | Chrome | Safari |
|---|---|---|
| `navigator.onLine` | Reliable | Unreliable (returns `true` when offline) |
| Background Sync API | Supported | Not reliably supported |
| IndexedDB Blob storage | Supported | Not supported (uses ArrayBuffer fallback) |
| SW `controller` on load | Available | May be `null` initially |
| Offline retry mechanism | Background Sync (`sync` event) | Polling `/api/health` from the SW |

## Project Structure

```
src/
  app/
    api/
      health/route.ts      # Health check endpoint (used by SW connectivity polling)
      trpc/[trpc]/route.ts  # tRPC API handler
    layout.tsx              # Root layout with PWA metadata
    manifest.ts             # PWA manifest (name, icons, display mode)
    page.tsx                # Main page (recording UI + state management)
    providers.tsx           # tRPC + React Query providers
    sw.ts                   # Service Worker (upload queue, retry, sync)
  components/
    record-button.tsx       # Audio recording with MediaRecorder API
    recordings-list.tsx     # Recording list with playback, download, delete
  lib/
    audio-store.ts          # IndexedDB operations (recordings + pending deletes)
    upload.ts               # Upload logic (presigned URL, S3 PUT, retry w/ backoff)
    sw-messages.ts          # TypeScript types for SW <-> page messages
    trpc/client.ts          # tRPC React client
  server/
    trpc.ts                 # tRPC initialization with SuperJSON
    routers/
      _app.ts               # Root router
      audio.ts              # Audio procedures (upload URL, save, delete, playback)
infra/
  index.ts                  # Pulumi IaC (S3, DynamoDB, ECS, ALB, CloudFront)
```

## Quick summary about the app behaviour

1. User records audio via MediaRecorder API
2. Recording is saved to IndexedDB with status `local`
3. Page sends `UPLOAD_RECORDING` message to the Service Worker
4. SW gets a presigned URL from the server, PUTs the file to S3, saves metadata to DynamoDB
5. On success, SW broadcasts `UPLOAD_STATUS_CHANGED` (status: `synced`) back to the page
6. Page updates UI and removes the local copy from IndexedDB

If the upload fails:
- **Network error:** status reverts to `local`, retry attempts are not consumed. On Chrome, Background Sync retries automatically. On Safari, the SW polls `/api/health` every 5s until connectivity returns, then retries.
- **Server error:** retries up to 3 times with exponential backoff. After max attempts, status is set to `failed`. The user can manually retry from the UI.

## Deployment

Infrastructure is managed with Pulumi. Resources created:

- S3 bucket (audio storage)
- DynamoDB table (recording metadata)
- ECR repository (Docker images)
- ECS Fargate cluster + service (container runtime)
- Application Load Balancer (health checks, routing)
- CloudFront distribution (CDN, HTTPS, caching)

### Deploy

```bash
# Build and push Docker image, then deploy infrastructure
./deploy.sh
```

This runs `pulumi up` against the `dev` stack in the `infra/` directory and outputs the service URL.

### Manual Docker Build

```bash
docker build -t caremates .
docker run -p 3000:3000 --env-file .env caremates
```

# Notes on the Architecture

### State Management and Sync Behaviour
The main goal here was to guarantee that user would never lose the audio until it's reliably synced with the cloud.
For that reason, we only consider a `sync` status when the upload succeeds to both S3 and DynamoDB, until there it lives locally
on the browser IndexedDB. This approach will allow us to detect errors on the server side, deploy a fix to the app if needed and
manually retry the upload from the user side without ever losing the audio. The main concern here is the fact that we have to
services we depend on, S3 and DynamoDB. Being self-managed by AWS, we can't control its status thus becoming possible points
of failure. The designed implemented leverages a model of eventual-consistency with the guarantee that the audio lives fully on
our servers before being erased from the browser IndexedDB.


### Sync-Engine Queue and Conflict Handling
Instead of a traditional array-based queue, the approach followed a promise chain queue in the Service Worker. On top of the
simplicity benefit, this implementation guarantees a sequential execution of the jobs, thus avoiding concurrency edge cases. 
Since the promise resolves only when the task finishes, this keeps the Service Worker alive until the job is fully completed.
Finally, a failed upload will not block the queue since the next task is executed weather the promise resolves or rejects.
With this design, we can handle natively the conflicts. In a scenario where the user clicks `delete` while the audio is uploading,
under the hood, the uploading task is going to finish and only then the `deletion` will happen. We avoid the extra complexity
of checking the real time status of a specific audio, but it is a perfectly reasonable since the potential network overhead added
and cloud cost is going to be minimal compared to how resilient the application is.

### Idempotency
S3 upload and DynamoDB save are naturally idempotent operations, as long as the same key is used. For the reason, our implementation
is idempotent on retries, but we still keep track via de `s3key` if the audio is uploaded or not to S3 in order to avoid repeating 
necessary requests.


### Retry Algorithm
The implementation follows the classical exponential base with a random jitter to avoid clients retrying all at the exact time. Even though
our approach with the `Sync Queue` would natively avoid this, it's a good practice to implement an extra layer of safety.
Since not all errors are worth, this is something also taken care on the implementation. For example, in case of a connection drop while uploading
or a `4xx` error, the `local`/`failed` status is returned and the number of attempts reseted.


### Queue Persistence and Memory Management
One of the main concerns here is that browsers have limited storage and can delete the content of the 
IndexedDB silently if under pressure. To avoid this we implemented two mechanisms: `navigator.storage.persist()` asks the browser
to persist our data + `navigator.storage.estimate()` is used to check the available storage before every recording; if less than our
defined threshold, it will ask the user to delete recordings. This is an edge case that can happen if there is an accumulation of many audios
that were not synced to our server.
Another pain point is the output size of the audio. Currently, for both Safari and Chrome, the output size is around
1MB/minute (WebM/Opus and MP4/AAC), which means that a 1-hour audio could weight roughly ~80M. S3 single PUT supports up to 5GB, considering a 2-hour
audio, could take around 150 seconds. Although the current implementation is believed to handle most scenarios there are some potential bottlenecks
that are worth mention for future improvement:
- For files larger than 200MB, the S3 upload could become a problem. A way to tackle this is by using multipart upload that would split our audio
into chunks.
- Chunk recording: for large files, we could do the same as above but for recording: ` MediaRecorder.start(timeslice)` emits data chunks at intervals that
could be uploaded while the audio is being still recorded.
- Local memory: the audio blob is stored in memory; a fine-tuned mechanism to prevent uploads and predict the required space for future audios can help reduce problems.
For very large audios consistently, we could consider using the Origin Private File System that is faster and optimized for heavy files and direct-to-disk write operations.
