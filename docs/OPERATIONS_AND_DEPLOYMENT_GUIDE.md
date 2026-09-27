# Complete Kubernetes Operations & Deployment Manual
**Target Architecture**: Decoupled Microservices on Kubernetes (K3s)  
**Domains**:
- **REST API**: `https://staging-api.eizy.trade` (Health: `/health`, Docs: `/docs`)
- **WebSockets**: `wss://staging-socket.eizy.trade`
- **Web Frontend**: `https://staging.eizy.trade` (or local dev: `http://localhost:8003`)

---

## Table of Contents
1. [System Architecture & Traffic Flow](#1-system-architecture--traffic-flow)
2. [How to Deploy Code Changes from Local to Server](#2-how-to-deploy-code-changes-from-local-to-server)
3. [How to Monitor Pods & Cluster Health](#3-how-to-monitor-pods--cluster-health)
4. [How to Stream Live Logs for Every Microservice](#4-how-to-stream-live-logs-for-every-microservice)
5. [What Files to Change If You Change Your Docker Username](#5-what-files-to-change-if-you-change-your-docker-username)
6. [Emergency Runbook & Zero-Downtime Rollback](#6-emergency-runbook--zero-downtime-rollback)

---

## 1. System Architecture & Traffic Flow

Every microservice runs as an isolated pod in namespace `gdsl-exchange`. All services share the same multi-stage Docker image (`ghcr.io/faiyyajansari1466/gdsl-exchange-api:latest`), but execute distinct entrypoint commands.

```
                                  Internet
                                     │
                                     ▼
                    ┌─────────────────────────────────┐
                    │      Cloudflare Edge DNS        │
                    │   (staging-api / staging-socket)│
                    └────────────────┬────────────────┘
                                     │
                                     ▼
                    ┌─────────────────────────────────┐
                    │  Ingress-Nginx Controller (SSL) │
                    └───────┬─────────────────┬───────┘
                            │                 │
             HTTP /api, /docs                 │ WebSockets (WSS)
                            ▼                 ▼
                 ┌──────────────────┐ ┌───────────────────┐
                 │     gdsl-api     │ │    gdsl-socket    │
                 │   (2-10 Pods)    │ │    (2-8 Pods)     │
                 │  dist/server.js  │ │  dist/socket.js   │
                 └────────┬─────────┘ └─────────┬─────────┘
                          │                     │
                          │   ┌─────────────┐   │
                          ├──►│ gdsl-redis  │◄──┤ (Pub/Sub & Adapters)
                          │   │ (Port 6379) │   │
                          │   └──────▲──────┘   │
                          ▼          │          ▼
                 ┌───────────────────┴┐ ┌─────────────────┐
                 │gdsl-trading-engine │ │   gdsl-worker   │
                 │(STRICTLY 1 REPLICA)│ │ (1 REPLICA)     │
                 │dist/tradingEngine  │ │ dist/worker.js  │
                 └────────┬───────────┘ └───────┬─────────┘
                          │                     │
                          └──────────┬──────────┘
                                     ▼
                          ┌─────────────────────┐
                          │    gdsl-postgres    │
                          │     (Port 5432)     │
                          │   10GB SSD Volume   │
                          └─────────────────────┘
```

---

## 2. How to Deploy Code Changes from Local to Server

When you make changes to backend code on your local computer, follow this **4-step zero-downtime deployment cycle**:

### Step 2.1: Verify & Build on Local Machine
In `d:\faiz-p\gdsl-exchange-api`:
```bash
# 1. Build TypeScript packages
npm run build

# 2. Build the production Docker image
docker build -t ghcr.io/faiyyajansari1466/gdsl-exchange-api:latest -f docker/api.Dockerfile .
```

### Step 2.2: Push Image to GitHub Container Registry
```bash
docker push ghcr.io/faiyyajansari1466/gdsl-exchange-api:latest
```

### Step 2.3: Trigger Zero-Downtime Rolling Update on Droplet
SSH into your droplet and restart the deployments:
```bash
ssh root@139.59.30.70

# Trigger Kubernetes to pull the new image and perform rolling update
kubectl rollout restart deployment/gdsl-api -n gdsl-exchange
kubectl rollout restart deployment/gdsl-socket -n gdsl-exchange
kubectl rollout restart deployment/gdsl-trading-engine -n gdsl-exchange
kubectl rollout restart deployment/gdsl-worker -n gdsl-exchange
```

### Step 2.4: Watch the Rollout Complete
```bash
kubectl rollout status deployment/gdsl-api -n gdsl-exchange
kubectl rollout status deployment/gdsl-socket -n gdsl-exchange
```
*Kubernetes spins up new pods, waits for `/health` readiness checks to pass, routes traffic to them, and only then terminates the old pods. Users experience **zero downtime**.*

---

## 3. How to Monitor Pods & Cluster Health

All commands run on your Linux Droplet terminal.

### 3.1 Check All Pods & Status
```bash
kubectl get pods -n gdsl-exchange
```
**Example Healthy Output:**
```text
NAME                                   READY   STATUS    RESTARTS   AGE
gdsl-api-7bb598758b-9vlzd              1/1     Running   0          5m
gdsl-api-7bb598758b-zq2gv              1/1     Running   0          5m
gdsl-socket-58bc97d45c-9g7m4           1/1     Running   0          5m
gdsl-socket-58bc97d45c-j88qt           1/1     Running   0          5m
gdsl-trading-engine-86679f54fd-x9l7l   1/1     Running   0          5m
gdsl-worker-6b8ff6dcff-lhcjg           1/1     Running   0          5m
gdsl-postgres-7f654b9d8-k9x11          1/1     Running   0          10m
gdsl-redis-5c879d46f-2v4pm             1/1     Running   0          10m
```

### 3.2 Show Pod Details with IP Addresses and Nodes
```bash
kubectl get pods -n gdsl-exchange -o wide
```

### 3.3 Count Total Running Pods
```bash
kubectl get pods -n gdsl-exchange --no-headers | grep -c "Running"
```

### 3.4 Check Live Resource Usage (CPU and RAM)
```bash
# CPU and Memory per pod
kubectl top pods -n gdsl-exchange

# Server node CPU and Memory
kubectl top nodes
```

### 3.5 Diagnose Why a Pod Failed or Restarted
```bash
kubectl describe pod <POD_NAME> -n gdsl-exchange
```
*(Scroll to the bottom under **Events** to see the exact crash reason, OOMKilled, or failed probe).*

### 3.6 Check SSL Certificates & Ingress Routing
```bash
# Check if Let's Encrypt SSL certificate is valid
kubectl get certificate -n gdsl-exchange

# Check Ingress rules and assigned IP
kubectl get ingress -n gdsl-exchange
```

---

## 4. How to Stream Live Logs for Every Microservice

Use the `-f` (follow) flag to stream logs live in real time. Press `Ctrl + C` anytime to exit.

### 4.1 REST API Logs (All API Pods)
```bash
kubectl logs -f -l app=gdsl-api -n gdsl-exchange --tail=100
```

### 4.2 WebSocket Gateway Logs
```bash
kubectl logs -f -l app=gdsl-socket -n gdsl-exchange --tail=100
```

### 4.3 Autonomous Trading Engine & AI Bot Logs
```bash
kubectl logs -f -l app=gdsl-trading-engine -n gdsl-exchange --tail=100
```

### 4.4 Background Worker & Binance Feed Logs
```bash
kubectl logs -f -l app=gdsl-worker -n gdsl-exchange --tail=100
```

### 4.5 PostgreSQL Database Logs
```bash
kubectl logs -f -l app=gdsl-postgres -n gdsl-exchange --tail=50
```

### 4.6 Redis Logs
```bash
kubectl logs -f -l app=gdsl-redis -n gdsl-exchange --tail=50
```

### 4.7 Live External Traffic Logs (NGINX Ingress)
To see every HTTP request, IP address, and WebSocket connection hitting your server:
```bash
kubectl logs -f -n ingress-nginx -l app.kubernetes.io/name=ingress-nginx --tail=50
```

### 4.8 Filter Logs by Keyword (Grep)
```bash
# Only errors across API pods
kubectl logs -f -l app=gdsl-api -n gdsl-exchange | grep -i --color=auto "error"

# Only auth requests
kubectl logs -f -l app=gdsl-api -n gdsl-exchange | grep --color=auto "/api/auth"

# Only trades and engine execution
kubectl logs -f -l app=gdsl-trading-engine -n gdsl-exchange | grep --color=auto "trade"
```

---

## 5. What Files to Change If You Change Your Docker Username

If you ever change your GitHub username or Docker Hub account (e.g., from `faiyyajansari1466` to `newusername`):

### 5.1 Code Files to Update in `gdsl-exchange-api`:

| # | File Path | Line | What to Change |
| :--- | :--- | :--- | :--- |
| 1 | `k8s/api-deployment.yaml` | `28` | `image: ghcr.io/newusername/gdsl-exchange-api:latest` |
| 2 | `k8s/socket-deployment.yaml` | `28` | `image: ghcr.io/newusername/gdsl-exchange-api:latest` |
| 3 | `k8s/trading-engine-deployment.yaml` | `26` | `image: ghcr.io/newusername/gdsl-exchange-api:latest` |
| 4 | `k8s/worker-deployment.yaml` | `25` | `image: ghcr.io/newusername/gdsl-exchange-api:latest` |
| 5 | `k8s/migration-job.yaml` | `15` | `image: ghcr.io/newusername/gdsl-exchange-api:latest` |
| 6 | `k8s/deploy-staging.yaml` | `47, 124, 199, 239` | Change all 4 image references to `newusername` |
| 7 | `docs/DEPLOYMENT_PLAN.md` | `128, 131, 134, 154` | Update documentation commands |

### 5.2 Commands to Run After Changing Username:

#### 1. On your Local Computer:
```bash
# Log in with new username and token
docker login ghcr.io -u newusername

# Build and push with new tag
docker build -t ghcr.io/newusername/gdsl-exchange-api:latest -f docker/api.Dockerfile .
docker push ghcr.io/newusername/gdsl-exchange-api:latest
```

#### 2. On your Droplet Server:
Update the Kubernetes pull secret with the new username and token:
```bash
# Delete old secret
kubectl delete secret ghcr-secret -n gdsl-exchange

# Create new secret
kubectl create secret docker-registry ghcr-secret \
  --docker-server=ghcr.io \
  --docker-username=newusername \
  --docker-password=YOUR_NEW_GITHUB_PAT \
  -n gdsl-exchange

# Re-apply the deployment manifests
kubectl apply -f k8s/api-deployment.yaml
kubectl apply -f k8s/socket-deployment.yaml
kubectl apply -f k8s/trading-engine-deployment.yaml
kubectl apply -f k8s/worker-deployment.yaml
```

---

## 6. Emergency Runbook & Zero-Downtime Rollback

### 6.1 Instant Rollback to Previous Deployment
If a new release has a bug, revert instantly to the previous working version with **zero downtime**:
```bash
# Roll back API
kubectl rollout undo deployment/gdsl-api -n gdsl-exchange

# Roll back Trading Engine
kubectl rollout undo deployment/gdsl-trading-engine -n gdsl-exchange
```

### 6.2 View Revision History
```bash
kubectl rollout history deployment/gdsl-api -n gdsl-exchange
```

### 6.3 Restart Any Crashed Service
```bash
kubectl rollout restart deployment/gdsl-api -n gdsl-exchange
kubectl rollout restart deployment/gdsl-socket -n gdsl-exchange
kubectl rollout restart deployment/gdsl-trading-engine -n gdsl-exchange
kubectl rollout restart deployment/gdsl-worker -n gdsl-exchange
```

### 6.4 Sync Database Columns (Prisma Push)
If new database columns were added in code:
```bash
kubectl exec -it deployment/gdsl-api -n gdsl-exchange -- npx prisma db push --schema=packages/db/prisma/schema.prisma
```
