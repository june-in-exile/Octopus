# Use Node.js 18 slim image
FROM node:18-slim

# Set working directory
WORKDIR /app

# 1. Copy root and subdirectory package files to leverage caching
COPY package*.json ./
COPY sdk/package*.json ./sdk/
COPY relayer/package*.json ./relayer/

# 2. Install dependencies for everything
RUN npm install
RUN cd sdk && npm install
RUN cd relayer && npm install

# 3. Copy source code for SDK and Relayer
COPY sdk ./sdk
COPY relayer ./relayer

# 4. Build SDK (required for the relayer)
RUN cd sdk && npm run build

# 5. Build Relayer
RUN cd relayer && npm run build

# Set environment variables
ENV NODE_ENV=production
ENV RELAYER_PORT=8080

# Expose the application port
EXPOSE 8080

# 6. Start the Relayer using the compiled distribution
WORKDIR /app/relayer
CMD ["node", "dist/server.js"]
