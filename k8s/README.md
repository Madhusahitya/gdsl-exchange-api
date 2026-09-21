# Kubernetes & API Gateway Deployment Guide

This directory contains the production Kubernetes manifests for deploying **gdsl-exchange-api** (Express + Socket.IO + Prisma DB package).

---

## 1. Build and Push Container Image

```bash
# Build the Docker image from project root
docker build -t your-registry/gdsl-exchange-api:latest -f Dockerfile .

# Push image to your container registry (Docker Hub, ECR, GCR, GAR, Harbor, etc.)
docker push your-registry/gdsl-exchange-api:latest
```

---

## 2. Configure Secrets

Copy the secret template and populate real secrets:

```bash
cp k8s/secret.yaml.template k8s/secret.yaml
```

Edit `k8s/secret.yaml` and set production base64 or plaintext string values for:
- `DATABASE_URL`
- `JWT_SECRET`
- `JWT_REFRESH_SECRET`
- `ENCRYPTION_KEY`
- `WALLET_ENCRYPTION_KEY`

Apply ConfigMap and Secret:
```bash
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/secret.yaml
```

---

## 3. Run Database Migrations (Kubernetes Job)

Before rolling out updated API pods, apply Prisma database migrations:

```bash
kubectl apply -f k8s/migration-job.yaml
```

Check migration completion status:
```bash
kubectl get jobs gdsl-exchange-api-db-migration
```

---

## 4. Deploy API & Ingress Gateway

Deploy the Service, Deployment pods, and API Gateway Ingress:

```bash
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/api-gateway-ingress.yaml
```

Check rollout status:
```bash
kubectl rollout status deployment/gdsl-exchange-api
kubectl get ingress gdsl-exchange-api-ingress
```

---

## 5. Gateway Features Included

- **WebSocket Support**: Handles upgrade header protocols for Socket.IO (`/socket.io`).
- **Health Probes**: Liveness and Readiness probes configured on `/health`.
- **Security**: Non-root UID `1000` execution container environment.
- **High Availability**: Rolling updates with zero downtime (`maxSurge: 1`, `maxUnavailable: 0`).
