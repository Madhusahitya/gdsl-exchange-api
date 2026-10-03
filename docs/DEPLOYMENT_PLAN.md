# Production Kubernetes Deployment Plan

**Target Domains:**
- **Web App (Frontend):** `https://staging.eizy.trade`
- **REST API:** `https://staging-api.eizy.trade` (Health: `https://staging-api.eizy.trade/health`)
- **Real-time WebSockets:** `wss://staging-socket.eizy.trade`

---

## 1. System Architecture Overview

The backend runs as a decoupled 4-microservice architecture on Kubernetes:

```
                            ┌──────────────────────────────────────────────┐
                            │      Cloudflare DNS & Edge SSL               │
                            └──────────────────────┬───────────────────────┘
                                                   │
                                                   ▼
                            ┌──────────────────────────────────────────────┐
                            │    Ingress-Nginx Controller + Cert-Manager   │
                            │  (staging-api.eizy.trade, staging-socket...) │
                            └──────────────┬────────────────┬──────────────┘
                    (HTTP /docs, /api)     │                │ (WebSockets)
                                           ▼                ▼
                            ┌──────────────────────┐ ┌─────────────────────┐
                            │       gdsl-api       │ │     gdsl-socket     │
                            │  (HPA: 2 - 10 Pods)  │ │ (HPA: 2 - 8 Pods)   │
                            └──────────┬───────────┘ └──────────┬──────────┘
                                       │                        │
                                       │     ┌────────────┐     │
                                       ├────►│   Redis    │◄────┤
                                       │     │  Pub/Sub   │     │
                                       │     └─────▲──────┘     │
                                       ▼           │            ▼
                            ┌──────────────────────┤ ┌─────────────────────┐
                            │ gdsl-trading-engine  │ │     gdsl-worker     │
                            │ (STRICTLY 1 REPLICA) │ │  (STRICTLY 1 REPL)  │
                            └──────────┬───────────┘ └──────────┬──────────┘
                                       │                        │
                                       └───────────┬────────────┘
                                                   ▼
                                     ┌───────────────────────────┐
                                     │    Managed PostgreSQL     │
                                     └───────────────────────────┘
```

---

## 2. Pre-Deployment Checklist

Before beginning, ensure you have:
- [ ] SSH root access to your Linux server (Ubuntu 22.04 or 24.04 LTS).
- [ ] GitHub Personal Access Token (PAT) with `read:packages` and `write:packages` scope.
- [ ] Managed PostgreSQL connection string (`DATABASE_URL`).
- [ ] Managed Redis connection string (`REDIS_URL`).
- [ ] DNS management access (Cloudflare / Namecheap) for `eizy.trade`.

---

## Step 1: Install Kubernetes on the Linux Server

### Option A: Lightweight K3s (Recommended for Single Server / VPS)

SSH into your Linux server:
```bash
ssh root@YOUR_SERVER_IP
```

Install K3s in one command:
```bash
curl -sfL https://get.k3s.io | sh -
```

Configure `kubectl` permissions for your user:
```bash
mkdir -p ~/.kube
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
sudo chown $USER ~/.kube/config
```

Verify that the node is ready:
```bash
kubectl get nodes
```

---

## Step 2: Install Ingress-Nginx & Cert-Manager (SSL)

```bash
# 1. Install Ingress-Nginx Controller
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.10.0/deploy/static/provider/cloud/deploy.yaml

# 2. Install Cert-Manager for automated Let's Encrypt SSL
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.4/cert-manager.yaml

# 3. Wait for Cert-Manager pods to become ready
kubectl wait --namespace cert-manager --for=condition=ready pod --selector=app.kubernetes.io/instance=cert-manager --timeout=90s

# 4. Create Let's Encrypt Production ClusterIssuer
cat <<EOF | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@eizy.trade
    privateKeySecretRef:
      name: letsencrypt-prod-key
    solvers:
      - http01:
          ingress:
            class: nginx
EOF
```

---

## Step 3: Build & Push Docker Image to Container Registry

From your local development machine:

```bash
# 1. Login to GitHub Container Registry
echo "YOUR_GITHUB_PAT" | docker login ghcr.io -u faiyyajansari1466 --password-stdin

# 2. Build the production multi-stage image
docker build -t ghcr.io/faiyyajansari1466/gdsl-exchange-api:latest -f docker/api.Dockerfile .

# 3. Push the image to GHCR
docker push ghcr.io/faiyyajansari1466/gdsl-exchange-api:latest
```

---

## Step 4: Clone Code & Configure Kubernetes Secrets on Server

On the Linux server:

```bash
# 1. Clone repository to server
git clone git@github.com:faiyyajansari1466/gdsl-exchange-api.git /opt/trade_bot
cd /opt/trade_bot

# 2. Create the Kubernetes namespace
kubectl apply -f k8s/namespace.yaml

# 3. Create Docker Registry Secret for pulling images from GHCR
kubectl create secret docker-registry ghcr-secret \
  --docker-server=ghcr.io \
  --docker-username=faiyyajansari1466 \
  --docker-password=YOUR_GITHUB_PAT \
  -n gdsl-exchange

# 4. Create production secret file from template
cp k8s/secret.example.yaml k8s/secret.yaml
nano k8s/secret.yaml
```

Fill in your production credentials in `k8s/secret.yaml`:
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: gdsl-api-secrets
  namespace: gdsl-exchange
type: Opaque
stringData:
  DATABASE_URL: "postgresql://doadmin:YOUR_PASSWORD@your-db.ondigitalocean.com:25060/cryptoflow?sslmode=require"
  REDIS_URL: "rediss://default:YOUR_PASSWORD@your-redis.ondigitalocean.com:25061"
  JWT_SECRET: "YOUR_SECURE_JWT_SECRET_MIN_32_CHARS"
  ENCRYPTION_KEY: "YOUR_32_BYTE_HEX_ENCRYPTION_KEY"
  WALLET_ENCRYPTION_KEY: "YOUR_32_BYTE_HEX_WALLET_KEY"
  JUPITER_API_KEY: ""
  SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com"
```

Apply secrets and ConfigMap:
```bash
kubectl apply -f k8s/secret.yaml
kubectl apply -f k8s/configmap.yaml
```

---

## Step 5: Deploy the 4 Microservices to Kubernetes

Apply all deployment manifests:

```bash
# 1. Stateless REST API (2 pods, rolling update strategy)
kubectl apply -f k8s/api-deployment.yaml

# 2. Real-time Socket Gateway (2 pods, sticky sessions, Redis adapter)
kubectl apply -f k8s/socket-deployment.yaml

# 3. Autonomous Trading Engine (1 replica strictly)
kubectl apply -f k8s/trading-engine-deployment.yaml

# 4. Background Reconciliation & Feeds (1 replica strictly)
kubectl apply -f k8s/worker-deployment.yaml

# 5. Ingress & TLS certificates for staging-api and staging-socket
kubectl apply -f k8s/ingress.yaml

# 6. Horizontal Pod Autoscaling (HPA)
kubectl apply -f k8s/hpa.yaml
```

---

## Step 6: Configure DNS Records in Cloudflare

Find the external IP of your Ingress Controller:
```bash
kubectl get ingress -n gdsl-exchange
# or
kubectl get svc -n ingress-nginx ingress-nginx-controller
```

In your DNS provider (Cloudflare), add these two records pointing to the Ingress IP:

| Type | Name | Content / IPv4 | Proxy Status |
| :--- | :--- | :--- | :--- |
| `A` | `staging-api` | `YOUR_INGRESS_IP` | DNS Only (or Proxied) |
| `A` | `staging-socket` | `YOUR_INGRESS_IP` | DNS Only (or Proxied with WebSockets enabled) |

---

## Step 7: Verification & Health Checks

Run these commands to verify that the cluster is healthy:

```bash
# 1. Check all pods are in Running state
kubectl get pods -n gdsl-exchange

# 2. Check that SSL certificate is issued
kubectl get certificate -n gdsl-exchange

# 3. Test REST API Health endpoint
curl -I https://staging-api.eizy.trade/health
# Expected: HTTP/2 200 OK

# 4. Test Swagger UI Documentation
curl -I https://staging-api.eizy.trade/docs
# Expected: HTTP/2 200 or 301
```

---

## 8. Daily Operations & Zero-Downtime Cheat Sheet

### Deploying a New Release:
```bash
# 1. Build and push new image
docker build -t ghcr.io/faiyyajansari1466/gdsl-exchange-api:latest -f docker/api.Dockerfile .
docker push ghcr.io/faiyyajansari1466/gdsl-exchange-api:latest

# 2. Trigger rolling restart in Kubernetes
kubectl rollout restart deployment/gdsl-api -n gdsl-exchange
kubectl rollout restart deployment/gdsl-socket -n gdsl-exchange
kubectl rollout restart deployment/gdsl-trading-engine -n gdsl-exchange
kubectl rollout restart deployment/gdsl-worker -n gdsl-exchange

# 3. Watch status
kubectl rollout status deployment/gdsl-api -n gdsl-exchange
```

### Viewing Live Logs:
```bash
# REST API logs
kubectl logs -f deployment/gdsl-api -n gdsl-exchange --tail=100

# WebSocket logs
kubectl logs -f deployment/gdsl-socket -n gdsl-exchange --tail=100

# Trading Bot logs
kubectl logs -f deployment/gdsl-trading-engine -n gdsl-exchange --tail=100
```

### Instant Rollback:
If an update has an issue, revert immediately with zero downtime:
```bash
kubectl rollout undo deployment/gdsl-api -n gdsl-exchange
```
