

const axios = require('axios');

const generateInterViewLink = async (meetingDetails) => {

    async function getAccessToken() {
         const accountId = process.env.ZOOM_ACCOUNT_ID;
         const clientId = process.env.ZOOM_CLIENT_ID;
         const clientSecret = process.env.ZOOM_CLIENT_SECRET;
        const authUrl = "https://zoom.us/oauth/token";

        // Encode Client ID and Client Secret in Base64
        const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

        try {
            const response = await axios.post(`${authUrl}?grant_type=account_credentials&account_id=${accountId}`, null, {
                headers: {
                    'Authorization': `Basic ${authHeader}`
                }
            });

            return response.data.access_token;
        } catch (error) {
            console.error("Error getting access token:", error);
            return undefined;
        }
    }

    async function createZoomMeeting(meetingDetails) {
        const apiBaseUrl = "https://api.zoom.us/v2";
        const token = await getAccessToken();

        if (!token) return;

        const meetingConfig = {
            topic: meetingDetails.topic,
            type: 2, // Scheduled meeting
            start_time: meetingDetails.start_time, // ISO 8601 format, e.g., '2025-02-15T10:00:00Z'
            duration: meetingDetails.duration, // minutes
            password: '45#$F^HBAS', // ensure max 10
            settings: {
                join_before_host: true,
                waiting_room: false,
                // ... other settings
            }
        };
        try {
            const response = await axios.post(`${apiBaseUrl}/users/me/meetings`, meetingConfig, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });
        
            return response.data;

        } catch (error) {
            console.log("Error", error.response.data , "Error");
            return error.response.data
            
        }
    }

    return await createZoomMeeting(meetingDetails);
};

module.exports = { generateInterViewLink };