import { z } from "zod";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure } from "../trpc";

const region = process.env.CAREMATES_AWS_REGION!;

const credentials =
  process.env.CAREMATES_AWS_ACCESS_KEY_ID &&
  process.env.CAREMATES_AWS_SECRET_ACCESS_KEY
    ? {
        accessKeyId: process.env.CAREMATES_AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.CAREMATES_AWS_SECRET_ACCESS_KEY,
      }
    : undefined;

const s3 = new S3Client({
  region,
  credentials,
  requestChecksumCalculation: "WHEN_REQUIRED",
});

const dynamodb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region, credentials }),
);

export const audioRouter = router({
  getUploadUrl: publicProcedure
    .input(
      z.object({
        filename: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      const key = `recordings/${input.filename}`;

      try {
        const command = new PutObjectCommand({
          Bucket: process.env.CAREMATES_AWS_S3_BUCKET!,
          Key: key,
        });

        const url = await getSignedUrl(s3, command, { expiresIn: 300 });

        return { url, key };
      } catch (err) {
        console.error("Failed to generate presigned URL:", {
          filename: input.filename,
          key,
          error: err instanceof Error ? err.message : err,
        });

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to generate upload URL",
        });
      }
    }),

  deleteRecording: publicProcedure
    .input(
      z.object({
        s3Key: z.string(),
        id: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        await Promise.all([
          s3.send(
            new DeleteObjectCommand({
              Bucket: process.env.CAREMATES_AWS_S3_BUCKET!,
              Key: input.s3Key,
            }),
          ),
          dynamodb.send(
            new DeleteCommand({
              TableName: process.env.CAREMATES_AWS_DYNAMODB_TABLE!,
              Key: { id: input.id },
            }),
          ),
        ]);

        return { success: true };
      } catch (err) {
        console.error("Failed to delete recording:", {
          id: input.id,
          s3Key: input.s3Key,
          error: err instanceof Error ? err.message : err,
        });

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to delete recording",
        });
      }
    }),

  saveRecording: publicProcedure
    .input(
      z.object({
        id: z.string(),
        filename: z.string(),
        s3Key: z.string().optional(),
        fileSize: z.number(),
        duration: z.number(),
        recordedAt: z.string(),
        status: z.enum(["synced", "failed"]),
        lastError: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        await dynamodb.send(
          new PutCommand({
            TableName: process.env.CAREMATES_AWS_DYNAMODB_TABLE!,
            Item: {
              id: input.id,
              filename: input.filename,
              ...(input.s3Key && { s3Key: input.s3Key }),
              fileSize: input.fileSize,
              duration: input.duration,
              recordedAt: input.recordedAt,
              status: input.status,
              ...(input.lastError && { lastError: input.lastError }),
            },
          }),
        );

        return { success: true };
      } catch (err) {
        console.error("Failed to save recording to DynamoDB:", {
          id: input.id,
          filename: input.filename,
          s3Key: input.s3Key,
          fileSize: input.fileSize,
          duration: input.duration,
          recordedAt: input.recordedAt,
          status: input.status,
          lastError: input.lastError,
          error: err instanceof Error ? err.message : err,
        });

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to save recording to database",
        });
      }
    }),

  listRecordings: publicProcedure.query(async () => {
    try {
      const result = await dynamodb.send(
        new ScanCommand({
          TableName: process.env.CAREMATES_AWS_DYNAMODB_TABLE!,
          FilterExpression: "#s = :synced",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":synced": "synced" },
        }),
      );

      return (result.Items ?? []) as Array<{
        id: string;
        filename: string;
        s3Key: string;
        fileSize: number;
        duration: number;
        recordedAt: string;
        status: "synced";
      }>;
    } catch (err) {
      console.error("Failed to list recordings:", {
        error: err instanceof Error ? err.message : err,
      });

      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to list recordings",
      });
    }
  }),

  getPlaybackUrl: publicProcedure
    .input(z.object({ s3Key: z.string() }))
    .query(async ({ input }) => {
      try {
        const command = new GetObjectCommand({
          Bucket: process.env.CAREMATES_AWS_S3_BUCKET!,
          Key: input.s3Key,
        });

        const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
        return { url };
      } catch (err) {
        console.error("Failed to generate playback URL:", {
          s3Key: input.s3Key,
          error: err instanceof Error ? err.message : err,
        });

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to generate playback URL",
        });
      }
    }),

  getDownloadUrl: publicProcedure
    .input(z.object({ s3Key: z.string(), filename: z.string() }))
    .query(async ({ input }) => {
      try {
        const command = new GetObjectCommand({
          Bucket: process.env.CAREMATES_AWS_S3_BUCKET!,
          Key: input.s3Key,
          ResponseContentDisposition: `attachment; filename="${input.filename}"`,
        });

        const url = await getSignedUrl(s3, command, { expiresIn: 300 });
        return { url };
      } catch (err) {
        console.error("Failed to generate download URL:", {
          s3Key: input.s3Key,
          error: err instanceof Error ? err.message : err,
        });

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to generate download URL",
        });
      }
    }),
});
