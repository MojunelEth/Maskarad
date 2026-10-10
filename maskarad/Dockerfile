FROM node:22-bookworm-slim

# ffmpeg trims videos, fits them into the AI's frame, crops the result back and brings back the sound
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# No external npm dependencies, so no npm install is needed
COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
