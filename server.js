const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const dotenv = require('dotenv');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const fs = require('fs');
const { randomUUID } = require('crypto');
const crypto = require('crypto');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// Настройка ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath);

// Загрузка переменных окружения
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Создание временной директории для аудио файлов
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

// Инициализация Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Функция для очистки папки temp
function clearTempFolder() {
    try {
        console.log('Clearing temporary folder...');
        const files = fs.readdirSync(tempDir);

        if (files.length === 0) {
            console.log('Temporary folder is already empty');
            return;
        }

        let deletedCount = 0;
        for (const file of files) {
            const filePath = path.join(tempDir, file);
            fs.unlinkSync(filePath);
            deletedCount++;
        }

        console.log(`Deleted ${deletedCount} temporary files`);
    } catch (error) {
        console.error('Error clearing temporary folder:', error.message);
    }
}

// Функция для получения аудио из YouTube видео
async function getYoutubeAudio(url) {
    try {
        const videoId = extractYoutubeId(url);
        if (!videoId) {
            throw new Error('Invalid YouTube URL format');
        }

        const outputPath = path.join(tempDir, `${videoId}.mp3`);

        console.log('Getting video information for ID:', videoId);

        // Получаем информацию о видео через YouTube oEmbed API
        let videoTitle = `YouTube Video ${videoId}`;

        try {
            const videoInfoResponse = await axios.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
            if (videoInfoResponse.data && videoInfoResponse.data.title) {
                videoTitle = videoInfoResponse.data.title;
                console.log('Retrieved video title:', videoTitle);
            }
        } catch (infoError) {
            console.log('Failed to get video information via API, using ID as title');
        }

        // Проверяем, существует ли уже аудиофайл
        if (fs.existsSync(outputPath)) {
            console.log('Audio file already exists, skipping download');
            return {
                audioPath: outputPath,
                title: videoTitle,
                videoId: videoId
            };
        }

        console.log('Downloading audio from video...');

        // Получаем информацию о доступных форматах
        console.log('Getting available formats...');
        const info = await ytdl.getInfo(url);

        // Выводим информацию о доступных аудиоформатах для отладки
        const audioFormats = info.formats.filter(format => format.hasAudio && !format.hasVideo);

        // Улучшенная логика выбора аудиодорожки
        let selectedFormat = null;

        // 1. Сначала ищем оригинальную английскую дорожку по displayName и audioIsDefault
        selectedFormat = audioFormats.find(format =>
            format.audioTrack &&
            format.audioTrack.displayName &&
            format.audioTrack.displayName.includes("English") &&
            format.audioTrack.displayName.includes("original") &&
            format.audioTrack.audioIsDefault === true
        );

        console.log("Searching for original English track:", selectedFormat ? "Found" : "Not found");

        // 2. Если не нашли, ищем любую дорожку с audioIsDefault = true
        if (!selectedFormat) {
            selectedFormat = audioFormats.find(format =>
                format.audioTrack && format.audioTrack.audioIsDefault === true
            );
            console.log("Searching by audioIsDefault:", selectedFormat ? "Found" : "Not found");
        }

        // 3. Если не нашли, ищем любую английскую дорожку
        if (!selectedFormat) {
            selectedFormat = audioFormats.find(format =>
                format.audioTrack &&
                format.audioTrack.displayName &&
                (format.audioTrack.displayName.includes("English") ||
                    format.audioTrack.language === 'en' ||
                    format.audioTrack.language === 'eng' ||
                    format.language === 'en' ||
                    format.language === 'eng')
            );
            console.log("Searching for any English track:", selectedFormat ? "Found" : "Not found");
        }

        // 4. Если не нашли, ищем дорожку без указания языка
        if (!selectedFormat) {
            selectedFormat = audioFormats.find(format => !format.language && (!format.audioTrack || !format.audioTrack.language));
            console.log("Searching for track without language:", selectedFormat ? "Found" : "Not found");
        }

        // 5. Если и такой нет, берем первую доступную с наивысшим битрейтом
        if (!selectedFormat) {
            // Сортируем по битрейту (если доступен)
            const sortedFormats = [...audioFormats].sort((a, b) => {
                const bitrateA = a.audioBitrate || 0;
                const bitrateB = b.audioBitrate || 0;
                return bitrateB - bitrateA; // Сортировка по убыванию
            });
            selectedFormat = sortedFormats[0];
            console.log("Selected track with highest bitrate");
        }

        console.log('Selected audio format:', selectedFormat ?
            `itag=${selectedFormat.itag}, codecs=${selectedFormat.codecs}, audioTrack=${selectedFormat.audioTrack ? JSON.stringify(selectedFormat.audioTrack) : 'none'}` :
            'Using default filter');

        // Загружаем аудио с помощью ytdl-core и конвертируем с помощью ffmpeg
        return new Promise((resolve, reject) => {
            try {
                // Используем выбранный формат или фильтр, если формат не найден
                const videoReadableStream = selectedFormat
                    ? ytdl(url, { format: selectedFormat, highWaterMark: 1 << 25 })
                    : ytdl(url, {
                        quality: 'highest',
                        filter: format => {
                            // Выбираем только аудио форматы и предпочитаем оригинальную дорожку
                            return format.audioCodec && !format.qualityLabel;
                        },
                        highWaterMark: 1 << 25, // 32MB
                        requestOptions: {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9'
                            }
                        }
                    });

                // Обработка ошибок потока
                videoReadableStream.on('error', (err) => {
                    console.error('Error getting audio stream:', err);
                    reject(new Error(`Error getting audio stream: ${err.message}`));
                });

                console.log('Starting audio stream download...');

                const ffmpegProcess = ffmpeg(videoReadableStream)
                    .audioBitrate(128)
                    .format('mp3')
                    .on('start', () => {
                        console.log('Starting audio conversion...');
                    })
                    .on('progress', (progress) => {
                        if (progress.percent) {
                            console.log(`Conversion progress: ${Math.round(progress.percent)}%`);
                        }
                    })
                    .on('error', (err) => {
                        console.error('Error converting audio:', err);
                        reject(new Error(`Error converting audio: ${err.message}`));
                    })
                    .on('end', () => {
                        console.log('Audio successfully downloaded and converted:', outputPath);
                        resolve({
                            audioPath: outputPath,
                            title: videoTitle,
                            videoId: videoId
                        });
                    })
                    .save(outputPath);
            } catch (streamError) {
                console.error('Error creating stream:', streamError);
                reject(new Error(`Error creating stream: ${streamError.message}`));
            }
        });

    } catch (error) {
        console.error('Error getting audio from YouTube:', error);
        throw error;
    }
}

// Функция для извлечения ID видео из URL YouTube
function extractYoutubeId(url) {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

// Функция для получения аудио из Twitter/X видео
async function getTwitterBroadcastAudio(url) {
    try {
        console.log('Processing Twitter/X URL:', url);

        // Определяем тип URL (трансляция или обычный пост)
        let videoId;
        let outputFilename;

        if (url.includes('/broadcasts/')) {
            // Формат URL для трансляций
            const broadcastIdMatch = url.match(/\/broadcasts\/([^\/\?]+)/);

            if (!broadcastIdMatch || !broadcastIdMatch[1]) {
                throw new Error('Could not extract broadcast ID from URL');
            }

            videoId = broadcastIdMatch[1];
            outputFilename = `twitter_broadcast_${videoId}`;
        } else if (url.includes('/status/')) {
            // Формат URL для обычных постов
            const statusIdMatch = url.match(/\/status\/(\d+)/);

            if (!statusIdMatch || !statusIdMatch[1]) {
                throw new Error('Could not extract status ID from URL');
            }

            videoId = statusIdMatch[1];
            outputFilename = `twitter_status_${videoId}`;
        } else {
            throw new Error('Invalid Twitter/X URL format. Must contain /broadcasts/ or /status/');
        }

        const outputDir = path.join(tempDir);
        const outputPath = path.join(outputDir, `${outputFilename}.mp3`);

        // Проверяем, существует ли уже аудиофайл и удаляем его, чтобы избежать конфликтов
        if (fs.existsSync(outputPath)) {
            console.log('Audio file already exists, removing it before download');
            try {
                fs.unlinkSync(outputPath);
            } catch (unlinkError) {
                console.error('Error removing existing file:', unlinkError);
            }
        }

        // Проверяем, существует ли временный файл и удаляем его
        const tempFilePath = `${outputPath.replace('.mp3', '')}.temp`;
        if (fs.existsSync(tempFilePath)) {
            console.log('Temp file exists, removing it');
            try {
                fs.unlinkSync(tempFilePath);
            } catch (unlinkError) {
                console.error('Error removing existing temp file:', unlinkError);
            }
        }

        console.log('Downloading audio from Twitter/X...');

        // Сначала получаем метаданные, чтобы извлечь название
        const videoTitle = await getTwitterVideoTitle(url);
        console.log('Retrieved Twitter/X video title:', videoTitle);

        // Используем yt-dlp для скачивания аудио напрямую
        return new Promise((resolve, reject) => {
            // Команда для извлечения аудио напрямую
            // -x: извлечь аудио
            // --audio-format mp3: формат аудио
            // --audio-quality 0: лучшее качество
            // --ffmpeg-location: путь к ffmpeg
            const ffmpegLocation = ffmpegPath.replace(/\\/g, '/'); // Заменяем обратные слэши на прямые для совместимости

            // Добавляем уникальный идентификатор к имени файла для предотвращения конфликтов
            const uniqueOutputPath = outputPath.replace('.mp3', `_${Date.now()}`);

            exec(`yt-dlp "${url}" -x --audio-format mp3 --audio-quality 0 -o "${uniqueOutputPath}" --ffmpeg-location "${ffmpegLocation}" --quiet --no-warnings --no-progress`,
                { maxBuffer: 10 * 1024 * 1024 }, // 10 MB buffer
                async (error, stdout, stderr) => {
                    if (error) {
                        console.error('Error downloading Twitter/X audio:', error);
                        return reject(error);
                    }

                    if (stdout) console.log('yt-dlp output:', stdout.substring(0, 500) + (stdout.length > 500 ? '...' : ''));

                    // Проверяем, существует ли аудиофайл с расширением .mp3
                    const finalPath = `${uniqueOutputPath}.mp3`;
                    if (!fs.existsSync(finalPath)) {
                        return reject(new Error('Audio file was not downloaded'));
                    }

                    console.log('Audio successfully downloaded:', finalPath);

                    // Возвращаем информацию об аудиофайле
                    resolve({
                        audioPath: finalPath,
                        title: videoTitle,
                        videoId: videoId
                    });
                }
            );
        });
    } catch (error) {
        console.error('Error in getTwitterBroadcastAudio:', error);
        throw error;
    }
}

// Функция для получения названия видео из Twitter/X
async function getTwitterVideoTitle(url) {
    try {
        // Используем yt-dlp для получения только названия видео
        const result = await execPromise(`yt-dlp --skip-download --print title "${url}"`);
        
        // Проверяем, что получили какой-то результат
        if (result && result.stdout) {
            const title = result.stdout.trim();
            if (title) {
                return title;
            }
        }
        
        // Если не удалось получить название, извлекаем ID из URL
        let videoId = "";
        if (url.includes('/broadcasts/')) {
            const broadcastIdMatch = url.match(/\/broadcasts\/([^\/\?]+)/);
            if (broadcastIdMatch && broadcastIdMatch[1]) {
                videoId = broadcastIdMatch[1];
            }
        } else if (url.includes('/status/')) {
            const statusIdMatch = url.match(/\/status\/(\d+)/);
            if (statusIdMatch && statusIdMatch[1]) {
                videoId = statusIdMatch[1];
            }
        }
        
        return `Twitter/X Content (${videoId || 'unknown'})`;
    } catch (error) {
        console.error('Error getting Twitter video title:', error);
        // В случае ошибки возвращаем дефолтное название
        return `Twitter/X Content (${new Date().toISOString().slice(0, 10)})`;
    }
}

// Функция для разделения аудиофайла на части
async function splitAudioFile(audioPath, segmentDuration) {
    const outputDir = path.dirname(audioPath);
    const fileBaseName = path.basename(audioPath, path.extname(audioPath));
    const outputPattern = path.join(outputDir, `${fileBaseName}_part_%03d${path.extname(audioPath)}`);

    console.log(`Splitting audio file into segments of ${segmentDuration} seconds...`);

    try {
        // Используем ffmpeg из ffmpeg-static
        const ffmpegCommand = `"${ffmpegPath}" -i "${audioPath}" -f segment -segment_time ${segmentDuration} -c copy "${outputPattern}"`;
        console.log('Executing command:', ffmpegCommand);

        await execPromise(ffmpegCommand);

        // Получаем список созданных файлов
        const segmentFiles = fs.readdirSync(outputDir)
            .filter(file => file.startsWith(`${fileBaseName}_part_`))
            .map(file => path.join(outputDir, file))
            .sort(); // Сортируем, чтобы сохранить порядок

        console.log(`Audio file split into ${segmentFiles.length} parts`);
        return segmentFiles;
    } catch (error) {
        console.error('Error splitting audio file:', error);
        throw error;
    }
}

// Функция для транскрипции больших аудиофайлов
async function transcribeLargeAudio(audioInfo) {
    try {
        console.log('Processing large audio file...');

        // Разделяем аудиофайл на части
        const segmentFiles = await splitAudioFile(audioInfo.audioPath, process.env.SEGMENT_SIZE);
        let fullTranscription = '';

        // Обрабатываем каждый сегмент
        for (let i = 0; i < segmentFiles.length; i++) {
            console.log(`Processing segment ${i + 1}/${segmentFiles.length}...`);

            const segmentInfo = {
                audioPath: segmentFiles[i],
                title: `${audioInfo.title} (part ${i + 1}/${segmentFiles.length})`,
                videoId: audioInfo.videoId
            };

            // Используем стандартную функцию для транскрипции сегмента
            try {
                const segmentResult = await transcribeSegment(segmentInfo);
                fullTranscription += segmentResult.transcription + '\n\n';
                console.log(`Segment ${i + 1} successfully transcribed`);
            } catch (segmentError) {
                console.error(`Error transcribing segment ${i + 1}:`, segmentError);
                fullTranscription += `[Error transcribing part ${i + 1}]\n\n`;
            }

            // Удаляем временный файл сегмента
            try {
                fs.unlinkSync(segmentFiles[i]);
            } catch (unlinkError) {
                console.error(`Error deleting temporary segment file ${i + 1}:`, unlinkError);
            }
        }

        return {
            title: audioInfo.title,
            transcription: fullTranscription.trim()
        };
    } catch (error) {
        console.error('Error transcribing large audio file:', error);
        throw error;
    } finally {
        // Удаляем оригинальный аудиофайл
        if (fs.existsSync(audioInfo.audioPath)) {
            try {
                fs.unlinkSync(audioInfo.audioPath);
                console.log('Original audio file deleted');
            } catch (unlinkError) {
                console.error('Error deleting original audio file:', unlinkError);
            }
        }
    }
}

// Функция для транскрипции одного сегмента
async function transcribeSegment(segmentInfo) {
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || "gemini-2.5-pro" });

    console.log(`Transcribing segment: ${path.basename(segmentInfo.audioPath)}`);

    // Читаем аудиофайл и конвертируем в base64
    const audioFile = fs.readFileSync(segmentInfo.audioPath);
    const audioBase64 = audioFile.toString('base64');

    // Создаем промпт
    const prompt = "Create a complete transcription of this audio segment. Pay special attention to the first 5 minutes of the audio - ignore and exclude any song lyrics, musical intros, and background music that often appear at the beginning of videos. Throughout the entire audio, focus only on speech and dialogues. Return only the transcription text without any comments.";

    // Добавляем механизм повторных попыток
    const maxRetries = 3;
    let retryCount = 0;
    let lastError = null;

    while (retryCount < maxRetries) {
        try {
            // Отправляем запрос с текстом и аудио
            const result = await model.generateContent([
                { text: prompt },
                {
                    inlineData: {
                        data: audioBase64,
                        mimeType: "audio/mpeg"
                    }
                }
            ]);

            const response = await result.response;
            const text = response.text();

            return {
                title: segmentInfo.title,
                transcription: text
            };
        } catch (error) {
            lastError = error;
            retryCount++;
            console.error(`Error transcribing segment (attempt ${retryCount}/${maxRetries}):`, error.message);

            if (retryCount < maxRetries) {
                // Экспоненциальная задержка между попытками (1s, 2s, 4s...)
                const delay = 1000 * Math.pow(2, retryCount - 1);
                console.log(`Retrying in ${delay / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    // Если все попытки не удались, выбрасываем последнюю ошибку
    throw lastError;
}

// Функция для транскрипции больших аудиофайлов
async function transcribeWithGemini(audioInfo) {
    try {
        const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || "gemini-2.5-pro"});

        // Проверяем существование аудиофайла
        if (!fs.existsSync(audioInfo.audioPath)) {
            throw new Error('Audio file not found');
        }

        console.log('Sending request to Gemini API...');

        // Проверяем размер файла
        const stats = fs.statSync(audioInfo.audioPath);
        const fileSizeInMB = stats.size / (1024 * 1024);
        console.log(`Audio file size: ${fileSizeInMB.toFixed(2)} MB`);

        if (fileSizeInMB > process.env.MAX_SIZE) {
            console.log('File too large for direct submission, using file splitting method');
            return await transcribeLargeAudio(audioInfo);
        }

        try {
            // Для небольших файлов пробуем прямую отправку аудио
            console.log('Sending audio to Gemini API');

            // Создаем промпт
            const prompt = "Create a complete transcription of this audio. Pay special attention to the first 5 minutes of the audio - ignore and exclude any song lyrics, musical intros, and background music that often appear at the beginning of videos. Throughout the entire audio, focus only on speech and dialogues. Return only the transcription text without any comments.";

            // Читаем аудиофайл и конвертируем в base64
            const audioFile = fs.readFileSync(audioInfo.audioPath);
            const audioBase64 = audioFile.toString('base64');

            // Отправляем запрос с текстом и аудио в правильном формате
            const result = await model.generateContent([
                { text: prompt },
                {
                    inlineData: {
                        data: audioBase64,
                        mimeType: "audio/mpeg"
                    }
                }
            ]);

            const response = await result.response;
            const text = response.text();

            console.log('Response received from Gemini API');

            return {
                title: audioInfo.title,
                transcription: text
            };
        } catch (error) {
            console.error('Error sending audio directly:', error);
            console.log('Switching to URL method due to error');

            // В случае ошибки переключаемся на метод с URL
            return await transcribeWithURL(audioInfo);
        } finally {
            // Удаляем временный файл
            if (fs.existsSync(audioInfo.audioPath)) {
                try {
                    fs.unlinkSync(audioInfo.audioPath);
                    console.log('Temporary file deleted');
                } catch (unlinkError) {
                    console.error('Error deleting temporary file:', unlinkError);
                }
            }
        }
    } catch (error) {
        console.error('Error transcribing with Gemini:', error);

        // Удаляем временный файл в случае ошибки
        if (audioInfo.audioPath && fs.existsSync(audioInfo.audioPath)) {
            try {
                fs.unlinkSync(audioInfo.audioPath);
                console.log('Temporary file deleted');
            } catch (unlinkError) {
                console.error('Error deleting temporary file:', unlinkError);
            }
        }

        throw error;
    }
}

// Вспомогательная функция для транскрипции через URL
async function transcribeWithURL(audioInfo) {
    console.log('Using URL transcription method');

    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || "gemini-2.5-pro" });

    // Создаем промпт с информацией о видео
    const urlPrompt = `I want you to act as a transcriber for audio from a YouTube video.
    
  Video: "${audioInfo.title}" (ID: ${audioInfo.videoId})
  URL: https://www.youtube.com/watch?v=${audioInfo.videoId}
  
  Task: 
  1. Watch the video at the URL
  2. Create an accurate text transcription of the audio content
  3. Return only the transcription text without additional comments`;

    // Отправляем запрос только с текстом
    const result = await model.generateContent(urlPrompt);
    const response = await result.response;
    const text = response.text();

    console.log('Response received from Gemini API (URL method)');

    return {
        title: audioInfo.title,
        transcription: text
    };
}

// API эндпоинты
app.post('/transcribe', async (req, res) => {
    try {
        const { urls } = req.body;

        if (!urls || !Array.isArray(urls) || urls.length === 0) {
            return res.status(400).json({ error: 'URLs not provided or invalid format' });
        }

        // Очищаем папку temp перед началом обработки
        clearTempFolder();

        // Массив для хранения результатов транскрипции
        const results = [];
        const errors = [];

        // Обрабатываем каждый URL последовательно
        for (const url of urls) {
            try {
                console.log(`Processing URL: ${url}`);
                let audioInfo;

                // Автоматически определяем тип платформы по URL
                if (url.includes('youtube.com') || url.includes('youtu.be')) {
                    audioInfo = await getYoutubeAudio(url);
                } else if (url.includes('twitter.com') || url.includes('x.com')) {
                    audioInfo = await getTwitterBroadcastAudio(url);
                } else {
                    errors.push({ url, error: 'Unsupported platform. Only YouTube and Twitter/X are supported' });
                    continue;
                }

                const transcriptionResult = await transcribeWithGemini(audioInfo);
                results.push({
                    url,
                    ...transcriptionResult
                });
            } catch (urlError) {
                console.error(`Error processing URL ${url}:`, urlError);
                errors.push({ url, error: urlError.message || 'Error processing URL' });
            }
        }

        // Возвращаем результаты и ошибки (если есть)
        res.json({
            results,
            errors,
            totalProcessed: urls.length,
            successCount: results.length,
            errorCount: errors.length
        });
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
});

// Маршрут для главной страницы
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Web interface available at: http://localhost:${PORT}`);
});
