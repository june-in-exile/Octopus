# Use Node.js 22 slim image
FROM node:22-slim

# Install curl for healthcheck
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# 1. Copy root and subdirectory package files to leverage caching
COPY relayer/package*.json ./relayer/

# 2. Install dependencies for relayer
RUN cd relayer && npm install

# 3. Copy source code for Relayer
COPY relayer ./relayer

# 4. Build Relayer
RUN cd relayer && npm run build

# Create non-root user and set permissions
RUN addgroup --system relayer && adduser --system --ingroup relayer relayer
RUN chown -R relayer:relayer /app

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Switch to non-root user
USER relayer

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:8080/relayer-info || exit 1

# 5. Start the Relayer using the compiled distribution
WORKDIR /app/relayer
CMD ["node", "dist/src/server.js"]
