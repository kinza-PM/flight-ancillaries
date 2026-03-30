import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { globalHeaders, logTrace, getSessionId, createResponse, setRequestContext, logError } from "../helper/helper.js";
import redis from "../lib/redisClient.js";
import { createCacheKey } from "../lib/cacheKey.js";
import { verifyToken } from "./authorizerLayer.js";

export const handler = async (event, context) => {
    setRequestContext(event, context);
    
    try {
        // --- Token Verification ---
        const authVerification = await verifyToken(event);
        if (authVerification?.principalId === "unknown") {
            return createResponse(401, { message: "Unauthorized: Invalid or expired token" });
        }

        const body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
        const { searchKey } = body
        // --- Session ID from Provesio ---
        const { sessionId, conversationId } = await getSessionId(authVerification?.context?.sub, searchKey);
        if (!sessionId) {
            return createResponse(500, { message: "Login failed, no sessionId returned." });
        }

        if (!conversationId) {
            return createResponse(500, { message: "Login failed, no conversationId returned." });
        }

        // --- Caching ---
        const cacheKey = createCacheKey(body, "ancillarySearch");
        try {
            const cached = await redis.get(cacheKey);
            if (cached) {
                console.info("Cache HIT for", cacheKey);
                return createResponse(200, JSON.parse(cached));
            }
            console.info("Cache MISS for", cacheKey);
        } catch (redisErr) {
            console.error("Redis GET error (proceeding to API):", redisErr);
        }

        // --- Call Provesio Ancillary Search ---
        const searchResp = await axios.post(
            `${process.env.BASE_URL}/reservation/ancillary-search`,
            body,
            {
                timeout: 45000,
                headers: {
                    "Content-Type": "application/json",
                    "X-API-KEY": process.env.X_API_KEY,
                    conversationId,
                    sessionId,
                },
            }
        );

        // --- Cache the response ---
        try {
            await redis.set(cacheKey, JSON.stringify(searchResp.data), "EX", 300); // TTL: 5 min
            console.info("Cached result", cacheKey);
        } catch (redisWriteErr) {
            console.error("Redis SET error:", redisWriteErr);
        }

        // --- Log Trace ---
        const payload = {
            id: uuidv4(),
            userId: authVerification?.context?.sub,
            userType: authVerification?.context?.userType,
            request: body,
            response: searchResp.data,
            stepCode: 80,
            status: "active",
        };
        await logTrace(payload);

        return createResponse(200, searchResp.data);

    } catch (error) {
        console.error("Error in ancillary search:", error.response?.data || error.message, error.stack);
        
        await logError(error, {
            function: 'ancillarySearch',
            event: JSON.stringify(event)
        });
        
        return createResponse(500, {
            message: error.response?.data || "Internal Server Error",
            error: error.response?.data || error.message,
            stack: error.stack
        });
    }
};
