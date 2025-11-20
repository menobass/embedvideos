# 3Speak Video Upload Service

## Project Overview
This is a Node.js/TypeScript service for uploading videos using 3speak's infrastructure with TUS resumable uploads and MongoDB for metadata storage.

## Workspace Instructions
- This service handles video uploads with TUS protocol
- Generates random video IDs for each upload
- Stores metadata in MongoDB
- Returns embed URLs in format: https://play.3speak.tv/embed?v={username}/{videoId}
