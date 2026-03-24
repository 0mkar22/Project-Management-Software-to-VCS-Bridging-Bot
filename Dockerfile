# Base Image: Lightweight Node 20
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json first to leverage Docker layer caching
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code (respects .dockerignore)
COPY . .

# Expose the port Cloud Run will talk to
EXPOSE 3000

# Start the Tron Universal Router
CMD ["npx", "ts-node", "standup-bot-Generic/server.ts"]