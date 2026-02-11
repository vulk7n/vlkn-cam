# VLKN Watermark Server (Lite Edition)

Optimized for 2GB VPS environments. Single-file, memory-efficient.

## Requirements
-   Ubuntu VPS
-   Node.js 18+

## Deployment Guide

1.  **Copy Files**
    Copy the `api-server` folder to your VPS.
    ```bash
    scp -r ./api-server user@your-vps-ip:~/vlkn-watermark
    ```

2.  **Install & Setup**
    ```bash
    cd ~/vlkn-watermark
    npm install
    
    # EDIT YOUR WEBHOOK
    nano server.js
    # Find "YOUR_DISCORD_WEBHOOK_HERE" at the top and paste your webhook url.
    ```

3.  **Run (Optimized for Low Memory)**
    Use PM2 with memory limits and GC exposure.
    ```bash
    npm install -g pm2
    
    # Start with max memory restart at 500MB and expose-gc for aggressive cleanup
    pm2 start server.js --name "vlkn-watermark" --node-args="--expose-gc" --max-memory-restart 500M
    pm2 save
    pm2 startup
    ```

4.  **Firewall**
    Allow Port **35500**.
    ```bash
    sudo ufw allow 35500
    ```

## Config
Update `config.lua`:
```lua
Config.UploadServiceUrl = "http://YOUR-VPS-IP:35500/api/watermark"
```
