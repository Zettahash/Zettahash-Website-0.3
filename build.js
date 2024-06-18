import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import cheerio from 'cheerio';
import dotenv from 'dotenv';
import pg from 'pg';
import { v2 as translate } from '@google-cloud/translate';

const { Pool } = pg;

// Load environment variables from .env file
dotenv.config();

// Directories
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const srcDir = path.join(__dirname, 'src', 'en'); // Assuming source HTML files are in /src/en
const distDir = path.join(__dirname, 'dist');

// Ensure dist directory exists
fs.removeSync(distDir); // Delete the dist directory if it exists
fs.ensureDirSync(distDir); // Create the dist directory

// Tags to look for strings to translate
const tagsToTranslate = ['p', 'a', 'span', 'li', 'th', 'td', 'b', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div'];

// Load the Google Cloud Translation API
const translateClient = new translate.Translate();

// Load PostgreSQL database credentials from environment variables
const pool = new Pool({
  connectionString: process.env.NEON_DATABASE_URL,
});

// Function to create unique keys based on the text
const createUniqueKey = (text) => {
  return text.replace(/\s+/g, '_').substring(0, 20);
};

// Function to check and create tables if they do not exist
const createTablesIfNotExist = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS strings (
        id SERIAL PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        text TEXT NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS translations (
        id SERIAL PRIMARY KEY,
        string_id INTEGER REFERENCES strings(id) ON DELETE CASCADE,
        language_code TEXT NOT NULL,
        translated_text TEXT NOT NULL,
        UNIQUE(string_id, language_code)
      );
    `);
  } finally {
    client.release();
  }
};

// Function to load all keys from the database into an in-memory array
const loadAllKeys = async () => {
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT key FROM strings');
    return res.rows.map(row => row.key);
  } finally {
    client.release();
  }
};

// Function to load all translations into an in-memory structure
const loadAllTranslations = async () => {
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT s.key, t.language_code, t.translated_text FROM translations t JOIN strings s ON t.string_id = s.id');
    const translations = {};
    res.rows.forEach(row => {
      if (!translations[row.key]) {
        translations[row.key] = {};
      }
      translations[row.key][row.language_code] = row.translated_text;
    });
    return translations;
  } finally {
    client.release();
  }
};

// Function to get text content including <br> tags as line breaks
const getTextContentWithLineBreaks = (elem) => {
  return elem.html().replace(/<br\s*\/?>/gi, '\n').replace(/&nbsp;/g, ' ').trim();
};

// Function to process HTML files and replace strings with translations
const processHtmlFile = async (filePath, keys, translations, lang) => {
  const content = fs.readFileSync(filePath, 'utf8');
  const $ = cheerio.load(content);

  for (const tag of tagsToTranslate) {
    $(tag).each(async (i, elem) => {
      let text = '';
      let isHtml = false;
      if ($(elem).children('br').length > 0) {
        text = getTextContentWithLineBreaks($(elem));
        isHtml = true;
      } else if ($(elem).children().length === 0) {
        text = $(elem).text().trim();
      }

      if (text) {
        const key = createUniqueKey(text);
        if (!keys.includes(key)) {
          // Add new string to the database
          await findOrCreateString(text, keys);
          // Translate the string immediately
          const translatedText = await translateText(text, lang);
          await addTranslationToDatabase(key, lang, translatedText);
          translations[key] = { ...translations[key], [lang]: translatedText };
        }

        if (translations[key] && translations[key][lang]) {
          if (isHtml) {
            $(elem).html(translations[key][lang].replace(/\n/g, '<br>'));
          } else {
            $(elem).text(translations[key][lang]);
          }
        }
      }
    });
  }

  const newHtml = $.html();
  const outputFilePath = path.join(distDir, lang, path.relative(srcDir, filePath));
  fs.ensureFileSync(outputFilePath);
  fs.writeFileSync(outputFilePath, newHtml, 'utf8');
};

// Function to find or create a string in the database
const findOrCreateString = async (text, keys) => {
  const key = createUniqueKey(text);
  if (!keys.includes(key)) {
    const client = await pool.connect();
    try {
      await client.query('INSERT INTO strings (key, text) VALUES ($1, $2)', [key, text]);
      keys.push(key); // Add new key to in-memory array
    } catch (error) {
      if (error.code !== '23505') { // Ignore duplicate key error
        throw error;
      }
    } finally {
      client.release();
    }
  }
  return key;
};

// Function to translate text using Google Cloud Translation API
const translateText = async (text, targetLanguage) => {
  const [translation] = await translateClient.translate(text, targetLanguage);
  return translation;
};

// Function to add a translation to the database
const addTranslationToDatabase = async (key, lang, translatedText) => {
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT id FROM strings WHERE key = $1', [key]);
    if (res.rows.length > 0) {
      const stringId = res.rows[0].id;
      await client.query(
        'INSERT INTO translations (string_id, language_code, translated_text) VALUES ($1, $2, $3) ON CONFLICT (string_id, language_code) DO NOTHING',
        [stringId, lang, translatedText.replace(/\n/g, '<br>')]
      );
    }
  } finally {
    client.release();
  }
};

// Function to create translated strings in the database
const createTranslatedStrings = async (languages, translations) => {
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT id, key, text FROM strings');
    for (const lang of languages) {
      for (const row of res.rows) {
        if (!translations[row.key] || !translations[row.key][lang]) {
          const translatedText = await translateText(row.text.replace(/\n/g, '<br>'), lang);
          await client.query(
            'INSERT INTO translations (string_id, language_code, translated_text) VALUES ($1, $2, $3) ON CONFLICT (string_id, language_code) DO NOTHING',
            [row.id, lang, translatedText.replace(/<br>/g, '\n')]
          );
          if (!translations[row.key]) {
            translations[row.key] = {};
          }
          translations[row.key][lang] = translatedText.replace(/<br>/g, '\n'); // Add new translation to in-memory structure
        }
      }
    }
  } finally {
    client.release();
  }
};

// Function to copy assets
const copyAssets = (src, dest) => {
  fs.copySync(src, dest, {
    filter: (src, dest) => {
      const basename = path.basename(src);
      return !basename.endsWith('.html');
    }
  });
};

// Function to process directories recursively for creating translated files
const processDirectoryForTranslations = async (dir, keys, translations, lang) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const outputPath = path.join(distDir, lang, path.relative(srcDir, fullPath));

    if (entry.isDirectory()) {
      fs.ensureDirSync(outputPath);
      await processDirectoryForTranslations(fullPath, keys, translations, lang);
    } else if (entry.isFile() && path.extname(entry.name) === '.html') {
      await processHtmlFile(fullPath, keys, translations, lang);
    } else {
      fs.copySync(fullPath, outputPath);
    }
  }
};

// Function to copy specific folders to the top level of the dist directory
const copyTopLevelFolders = (folders, srcBaseDir, destBaseDir) => {
  folders.forEach(folder => {
    const srcPath = path.join(srcBaseDir, folder);
    const destPath = path.join(destBaseDir, folder);
    if (fs.existsSync(srcPath)) {
      copyAssets(srcPath, destPath);
    }
  });
};

// Function to copy root-level HTML files to the root of the dist directory
const copyRootHtmlFiles = (srcBaseDir, destBaseDir) => {
  const entries = fs.readdirSync(srcBaseDir, { withFileTypes: true });
  entries.forEach(entry => {
    if (entry.isFile() && path.extname(entry.name) === '.html') {
      const srcPath = path.join(srcBaseDir, entry.name);
      const destPath = path.join(destBaseDir, entry.name);
      fs.copySync(srcPath, destPath);
    }
  });
};

// Wrap the entire script in an immediately invoked async function
(async () => {
  // Ensure necessary tables exist
  await createTablesIfNotExist();

  // Load all keys from the database into an in-memory array
  const keys = await loadAllKeys();

  // Load all translations into an in-memory structure
  const translations = await loadAllTranslations();

  // Create translated strings in the database
  const languages = ['en', 'ko', 'zh', 'ar', 'pt', 'es', 'fr', 'de', 'ru']; // Including 'en' for English
  await createTranslatedStrings(languages, translations);

  // Process and copy the translated files for each language
  for (const lang of languages) {
    await processDirectoryForTranslations(srcDir, keys, translations, lang);
  }

  // Folders to copy to the top level of the dist directory
  const topLevelFolders = ['videos', 'css', 'js', 'images', 'fonts'];

  // Copy top-level folders
  copyTopLevelFolders(topLevelFolders, path.join(__dirname, 'src'), distDir);

  // Copy root-level HTML files to the root of the dist directory
  copyRootHtmlFiles(path.join(__dirname, 'src'), distDir);

  console.log('Build and translation complete.');
})();
