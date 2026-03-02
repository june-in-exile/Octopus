# Use Node.js 22 slim image
FROM node:22-slim

# Install curl for healthcheck
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

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

# Create non-root user and set permissions
RUN addgroup --system relayer && adduser --system --ingroup relayer relayer
RUN chown -R relayer:relayer /app

# Set environment variables
ENV NODE_ENV=production
# ✅ Unify port to 3001
ENV PORT=3001

# ✅ Expose port 3001
EXPOSE 3001

# Switch to non-root user
USER relayer

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:3001/relayer-info || exit 1

# 6. Start the Relayer using the compiled distribution
WORKDIR /app/relayer
CMD ["node", "dist/src/server.js"]
