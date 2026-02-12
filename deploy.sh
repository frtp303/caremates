#!/bin/bash
set -euo pipefail

echo "Deploying Caremates to AWS ECS Fargate..."

cd "$(dirname "$0")/infra"
pulumi up --yes --stack dev

echo ""
echo "Deployment complete!"
pulumi stack output serviceUrl