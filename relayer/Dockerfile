# Use Node.js 18 image
FROM node:18-slim

# Set working directory
WORKDIR /app

# Copy package.json and lock files (including root, sdk, and relayer)
COPY package*.json ./
COPY sdk/package*.json ./sdk/
COPY relayer/package*.json ./relayer/

# Install dependencies (including sdk and relayer)
RUN npm install
RUN cd sdk && npm install
RUN cd relayer && npm install

# Copy source code
COPY sdk ./sdk
COPY relayer ./relayer

# Build SDK (if the relayer depends on it)
RUN cd sdk && npm run build

# Build Relayer
RUN cd relayer && npm run build

# Set environment variables
ENV NODE_ENV=production
ENV RELAYER_PORT=8080

# Expose port
EXPOSE 8080

# Start command (using built files)
WORKDIR /app/relayer
CMD ["node", "dist/server.js"]