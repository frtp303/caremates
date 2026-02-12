import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

const audioBucket = new aws.s3.BucketV2("caremates-audio", {
  forceDestroy: true,
});

new aws.s3.BucketLifecycleConfigurationV2("audio-lifecycle", {
  bucket: audioBucket.id,
  rules: [
    {
      id: "abort-incomplete-uploads",
      status: "Enabled",
      abortIncompleteMultipartUpload: {
        daysAfterInitiation: 1,
      },
    },
  ],
});

const recordingsTable = new aws.dynamodb.Table("caremates-recordings", {
  billingMode: "PAY_PER_REQUEST",
  hashKey: "id",
  attributes: [{ name: "id", type: "S" }],
});

const appUser = new aws.iam.User("caremates-app");

new aws.iam.UserPolicy("caremates-app-policy", {
  user: appUser.name,
  policy: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
        Resource: audioBucket.arn.apply((arn) => `${arn}/*`),
      },
      {
        Effect: "Allow",
        Action: [
          "dynamodb:PutItem",
          "dynamodb:GetItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:Scan",
        ],
        Resource: recordingsTable.arn,
      },
    ],
  },
});

const appAccessKey = new aws.iam.AccessKey("caremates-app-key", {
  user: appUser.name,
});

const repo = new awsx.ecr.Repository("caremates-repo", {
  forceDelete: true,
});

const image = new awsx.ecr.Image("caremates-image", {
  repositoryUrl: repo.url,
  context: "../",
  dockerfile: "../Dockerfile",
  platform: "linux/amd64",
});

const cluster = new aws.ecs.Cluster("caremates-cluster");

const alb = new awsx.lb.ApplicationLoadBalancer("caremates-alb", {
  defaultTargetGroup: {
    port: 3000,
    protocol: "HTTP",
    targetType: "ip",
    healthCheck: {
      path: "/",
      protocol: "HTTP",
      port: "3000",
    },
  },
  listener: {
    port: 80,
    protocol: "HTTP",
  },
});

const cachingDisabled = aws.cloudfront
  .getCachePolicyOutput({ name: "Managed-CachingDisabled" })
  .apply((p) => p.id!);
const cachingOptimized = aws.cloudfront
  .getCachePolicyOutput({ name: "Managed-CachingOptimized" })
  .apply((p) => p.id!);
const allViewer = aws.cloudfront
  .getOriginRequestPolicyOutput({ name: "Managed-AllViewer" })
  .apply((p) => p.id!);

const cdn = new aws.cloudfront.Distribution("caremates-cdn", {
  enabled: true,
  isIpv6Enabled: true,

  origins: [
    {
      originId: "alb",
      domainName: alb.loadBalancer.dnsName,
      customOriginConfig: {
        httpPort: 80,
        httpsPort: 443,
        originProtocolPolicy: "http-only",
        originSslProtocols: ["TLSv1.2"],
      },
    },
  ],

  defaultCacheBehavior: {
    targetOriginId: "alb",
    viewerProtocolPolicy: "redirect-to-https",
    allowedMethods: [
      "GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE",
    ],
    cachedMethods: ["GET", "HEAD"],
    compress: true,
    cachePolicyId: cachingDisabled,
    originRequestPolicyId: allViewer,
  },

  orderedCacheBehaviors: [
    {
      pathPattern: "/_next/static/*",
      targetOriginId: "alb",
      viewerProtocolPolicy: "https-only",
      allowedMethods: ["GET", "HEAD"],
      cachedMethods: ["GET", "HEAD"],
      compress: true,
      cachePolicyId: cachingOptimized,
    },
  ],

  restrictions: {
    geoRestriction: { restrictionType: "none" },
  },

  viewerCertificate: {
    cloudfrontDefaultCertificate: true,
  },

  waitForDeployment: true,
});

new aws.s3.BucketCorsConfigurationV2("audio-cors", {
  bucket: audioBucket.id,
  corsRules: [
    {
      allowedHeaders: ["*"],
      allowedMethods: ["PUT"],
      allowedOrigins: [
        "http://localhost:3000",
        cdn.domainName.apply((domain) => `https://${domain}`),
      ],
      maxAgeSeconds: 3600,
    },
  ],
});

new awsx.ecs.FargateService("caremates-service", {
  cluster: cluster.arn,
  assignPublicIp: true,
  desiredCount: 1,
  healthCheckGracePeriodSeconds: 60,
  taskDefinitionArgs: {
    cpu: "256",
    memory: "512",
    taskRole: {
      args: {
        inlinePolicies: [
          {
            name: "caremates-task-policy",
            policy: pulumi
              .all([audioBucket.arn, recordingsTable.arn])
              .apply(([bucketArn, tableArn]) =>
                JSON.stringify({
                  Version: "2012-10-17",
                  Statement: [
                    {
                      Effect: "Allow",
                      Action: [
                        "s3:PutObject",
                        "s3:GetObject",
                        "s3:DeleteObject",
                      ],
                      Resource: `${bucketArn}/*`,
                    },
                    {
                      Effect: "Allow",
                      Action: [
                        "dynamodb:PutItem",
                        "dynamodb:GetItem",
                        "dynamodb:UpdateItem",
                        "dynamodb:DeleteItem",
                        "dynamodb:Query",
                        "dynamodb:Scan",
                      ],
                      Resource: tableArn,
                    },
                  ],
                }),
              ),
          },
        ],
      },
    },
    container: {
      name: "caremates-app",
      image: image.imageUri,
      cpu: 256,
      memory: 512,
      essential: true,
      portMappings: [
        {
          containerPort: 3000,
          hostPort: 3000,
          targetGroup: alb.defaultTargetGroup,
        },
      ],
      environment: [
        { name: "CAREMATES_AWS_REGION", value: "eu-north-1" },
        {
          name: "CAREMATES_AWS_S3_BUCKET",
          value: audioBucket.id,
        },
        {
          name: "CAREMATES_AWS_DYNAMODB_TABLE",
          value: recordingsTable.name,
        },
      ],
    },
  },
});

export const bucketName = audioBucket.id;
export const tableName = recordingsTable.name;
export const appAccessKeyId = appAccessKey.id;
export const appSecretAccessKey = appAccessKey.secret;
export const repoUrl = repo.url;
export const serviceUrl = cdn.domainName.apply(
  (domain) => `https://${domain}`,
);
