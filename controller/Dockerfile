# controller — Node app: task intake + drives engines via @opencode-ai/sdk.
# Build context = controller/  (CI passes context: controller).
FROM node:22-slim

WORKDIR /app

# Install deps first for layer caching.
COPY package.json ./
RUN npm install --omit=dev

COPY index.mjs login.mjs ./

CMD ["node", "index.mjs"]
