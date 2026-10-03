# Kubernetes Production Deployment Guide for Godslandx Trading API

This directory contains the production-grade Kubernetes manifests for running the **4-Service Decoupled Architecture** with zero downtime, automated self-healing, and horizontal autoscaling.

---

## 1. Architecture Overview in Kubernetes

| Service | K8s Kind | Replicas / Scaling | Scaling Policy | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **API Server** | `Deployment` | 2 – 10 (HPA) | CPU > 70% | Stateless HTTP REST endpoints (auth, dashboard, orders, KYC) |
| **Socket Gateway** | `Deployment` | 2 – 8 (HPA) | CPU > 70% | Real-time WebSockets with `@socket.io/redis-adapter` |
| **Trading Engine** | `Deployment` | **1 (Strictly Singleton)** | `strategy: Recreate` | Position watchers (Jupiter, Pancake, 1inch) & AI bots. **Never scale to >1!** |
| **Worker** | `Deployment` | **1 (Strictly Singleton)** | `strategy: Recreate` | Binance order reconciliation, kline feeds, ML priors |

---

## 2. Prerequisites

1. **Managed Kubernetes Cluster**:
   - DigitalOcean Kubernetes (DOKS), AWS EKS, or Google GKE.
   - Recommended: 3 worker nodes (e.g. 4 vCPU / 8 GB RAM each).
2. **External Managed Database & Cache** (DO NOT run databases inside ephemeral K8s pods!):
   - Managed PostgreSQL 16 (with automated failover standby node)
   - Managed Redis 7 (cluster or primary-replica)
3. **Ingress Controller & Cert-Manager**:
   ```bash
   # Install Ingress-Nginx
   kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.10.0/deploy/static/provider/cloud/deploy.yaml

   # Install cert-manager for automatic Let's Encrypt SSL
   kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.4/cert-manager.yaml
   ```

---

## 3. Deployment Steps

```bash
# 1. Create the namespace
kubectl apply -f k8s/namespace.yaml

# 2. Configure secrets (copy secret.example.yaml to secret.yaml and populate)
cp k8s/secret.example.yaml k8s/secret.yaml
# Edit k8s/secret.yaml with production DATABASE_URL and REDIS_URL
kubectl apply -f k8s/secret.yaml

# 3. Apply ConfigMap
kubectl apply -f k8s/configmap.yaml

# 4. Deploy all services
kubectl apply -f k8s/api-deployment.yaml
kubectl apply -f k8s/socket-deployment.yaml
kubectl apply -f k8s/trading-engine-deployment.yaml
kubectl apply -f k8s/worker-deployment.yaml

# 5. Apply Ingress & Autoscalers
kubectl apply -f k8s/ingress.yaml
kubectl apply -f k8s/hpa.yaml
```

---

## 4. Zero-Downtime Rolling Update

When you push a new Docker image to `ghcr.io/faiyyajansari1466/gdsl-exchange-api:v1.2.0`:
```bash
kubectl set image deployment/gdsl-api api=ghcr.io/faiyyajansari1466/gdsl-exchange-api:v1.2.0 -n gdsl-exchange
kubectl set image deployment/gdsl-socket socket=ghcr.io/faiyyajansari1466/gdsl-exchange-api:v1.2.0 -n gdsl-exchange
kubectl set image deployment/gdsl-trading-engine trading-engine=ghcr.io/faiyyajansari1466/gdsl-exchange-api:v1.2.0 -n gdsl-exchange
kubectl set image deployment/gdsl-worker worker=ghcr.io/faiyyajansari1466/gdsl-exchange-api:v1.2.0 -n gdsl-exchange
```
Kubernetes will:
1. Spin up a new pod alongside the existing ones.
2. Wait for the `readinessProbe` (`/health`) to return HTTP 200 OK.
3. Add the new pod to the Ingress endpoints.
4. Send `SIGTERM` to the old pod, allowing `setupGracefulShutdown` to drain in-flight requests.
5. Terminate the old pod only after zero traffic is hitting it.
