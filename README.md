# ATS Resume Parser

An Applicant Tracking System (ATS) that parses resumes using Google's Gemini AI and stores the extracted data in Supabase.

## Features

- 📄 Upload single or multiple resume files (PDF, DOC, DOCX, TXT)
- 🤖 AI-powered resume parsing using Google Gemini
-   Store parsed data in Supabase database
-   Search and view parsed resumes
-   Extract skills, experience, education, location, and personal details

## Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- Supabase account and project
- Google Gemini API key

## Setup Instructions

### 1. Backend Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file in the root directory:
```env
PORT=3000
GEMINI_API_KEY=your_gemini_api_key_here
SUPABASE_URL=your_supabase_url_here
SUPABASE_KEY=your_supabase_anon_key_here
```

3. Set up Supabase database:
   - Go to your Supabase project
   - Navigate to SQL Editor
   - Run the SQL script from `supabase_schema.sql` to create the necessary table

### 2. Frontend Setup

1. Navigate to the Frontend directory:
```bash
cd Frontend
```

2. Install dependencies:
```bash
npm install
```

3. The frontend is configured to proxy API requests to `http://localhost:3000`

### 3. Running the Application

1. Start the backend server:
```bash
npm start
# or for development with auto-reload:
npm run dev
```

2. In a new terminal, start the frontend:
```bash
cd Frontend
npm run dev
```

3. Open your browser and navigate to `http://localhost:8080`

## API Endpoints

### Upload Resumes
- `POST /api/upload/single` - Upload a single resume file
- `POST /api/upload/bulk` - Upload multiple resume files

### Resume Management
- `GET /api/resumes` - Get all resumes
- `GET /api/resumes/:id` - Get a specific resume by ID
- `GET /api/resumes/search/:query` - Search resumes
- `DELETE /api/resumes/:id` - Delete a resume

## Project Structure

```
ATS/
├── server.js                 # Main server file
├── package.json              # Backend dependencies
├── .env                      # Environment variables (create this)
├── config/
│   ├── database.js          # Supabase configuration
│   └── gemini.js            # Gemini AI configuration
├── routes/
│   ├── upload.js            # Upload endpoints
│   └── resumes.js           # Resume management endpoints
├── utils/
│   └── resumeParser.js      # Resume parsing logic
├── uploads/                 # Temporary file storage (auto-created)
└── Frontend/
    ├── src/
    │   ├── App.vue          # Main Vue component
    │   ├── main.js          # Vue app entry point
    │   ├── router/
    │   │   └── index.js     # Vue Router configuration
    │   └── views/
    │       ├── UploadPage.vue    # Resume upload page
    │       └── ResumesPage.vue   # Resume listing page
    └── package.json         # Frontend dependencies
```

## Getting API Keys

### Google Gemini API Key
1. Go to [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Create a new API key
3. Copy the key to your `.env` file

### Supabase Credentials
1. Go to your [Supabase Dashboard](https://app.supabase.com)
2. Select your project
3. Go to Settings > API
4. Copy the Project URL and anon/public key to your `.env` file

## Notes

- Uploaded files are temporarily stored and automatically deleted after processing
- The system supports PDF, DOC, DOCX, and TXT file formats
- Maximum file size is 10MB per file
- Bulk upload supports up to 50 files at once

## License

ISC

