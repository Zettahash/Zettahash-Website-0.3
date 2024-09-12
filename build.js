import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import cheerio from 'cheerio';
import dotenv from 'dotenv';
import pg from 'pg';
import { v2 as translate } from '@google-cloud/translate';

dotenv.config();

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const srcDir = path.join(__dirname, 'src', 'en');
const distDir = path.join(__dirname, 'dist');
const tagsToTranslate = ['p', 'a', 'span', 'li', 'th', 'td', 'b', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div'];
const translateClient = new translate.Translate();
const pool = new Pool({ connectionString: process.env.NEON_DATABASE_URL });

fs.removeSync(distDir);
fs.ensureDirSync(distDir);

const createUniqueKey = text => text.replace(/\s+/g, '_').substring(0, 20);

const query = async (text, params) => {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
};

const createTablesIfNotExist = async () => {
  await query(`
    CREATE TABLE IF NOT EXISTS strings (
      id SERIAL PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      text TEXT NOT NULL
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS translations (
      id SERIAL PRIMARY KEY,
      string_id INTEGER REFERENCES strings(id) ON DELETE CASCADE,
      language_code TEXT NOT NULL,
      translated_text TEXT NOT NULL,
      UNIQUE(string_id, language_code)
    );
  `);
};

const loadAllKeys = async () => {
  const res = await query('SELECT key FROM strings');
  return res.rows.map(row => row.key);
};

const loadAllTranslations = async () => {
  const res = await query('SELECT s.key, t.language_code, t.translated_text FROM translations t JOIN strings s ON t.string_id = s.id');
  const translations = {};
  res.rows.forEach(row => {
    if (!translations[row.key]) translations[row.key] = {};
    translations[row.key][row.language_code] = row.translated_text;
  });
  return translations;
};

const getTextContentWithLineBreaks = elem => elem.html().replace(/<br\s*\/?>/gi, '\n').replace(/&nbsp;/g, ' ').trim();

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
          await findOrCreateString(text, keys);
          const translatedText = await translateText(text, lang);
          await addTranslationToDatabase(key, lang, translatedText);
          translations[key] = { ...translations[key], [lang]: translatedText };
        }

        if (translations[key] && translations[key][lang]) {
          if (isHtml) $(elem).html(translations[key][lang].replace(/\n/g, '<br>'));
          else $(elem).text(translations[key][lang]);
        }
      }
    });
  }

  // Alter href attributes in <a> tags
  $('a').each((i, elem) => {
    const href = $(elem).attr('href');
    if (href && href.includes('/en/')) {
      $(elem).attr('href', href.replace('/en/', `/${lang}/`));
    }
  });

  const newHtml = $.html();
  const outputFilePath = path.join(distDir, lang, path.relative(srcDir, filePath));
  fs.ensureFileSync(outputFilePath);
  fs.writeFileSync(outputFilePath, newHtml, 'utf8');
};

const findOrCreateString = async (text, keys) => {
  const key = createUniqueKey(text);
  if (!keys.includes(key)) {
    try {
      await query('INSERT INTO strings (key, text) VALUES ($1, $2)', [key, text]);
      keys.push(key);
    } catch (error) {
      if (error.code !== '23505') throw error;
    }
  }
  return key;
};

const translateText = async (text, targetLanguage) => {
  const [translation] = await translateClient.translate(text, targetLanguage);
  return translation;
};

const addTranslationToDatabase = async (key, lang, translatedText) => {
  const res = await query('SELECT id FROM strings WHERE key = $1', [key]);
  if (res.rows.length > 0) {
    const stringId = res.rows[0].id;
    await query(
      'INSERT INTO translations (string_id, language_code, translated_text) VALUES ($1, $2, $3) ON CONFLICT (string_id, language_code) DO NOTHING',
      [stringId, lang, translatedText.replace(/\n/g, '<br>')]
    );
  }
};

const createTranslatedStrings = async (languages, translations) => {
  const res = await query('SELECT id, key, text FROM strings');
  for (const lang of languages) {
    for (const row of res.rows) {
      if (!translations[row.key] || !translations[row.key][lang]) {
        const translatedText = await translateText(row.text.replace(/\n/g, '<br>'), lang);
        await query(
          'INSERT INTO translations (string_id, language_code, translated_text) VALUES ($1, $2, $3) ON CONFLICT (string_id, language_code) DO NOTHING',
          [row.id, lang, translatedText.replace(/<br>/g, '\n')]
        );
        if (!translations[row.key]) translations[row.key] = {};
        translations[row.key][lang] = translatedText.replace(/<br>/g, '\n');
      }
    }
  }
};

const copyAssets = (src, dest) => {
  fs.copySync(src, dest, {
    filter: src => !path.basename(src).endsWith('.html')
  });
};

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

const copyTopLevelFolders = (folders, srcBaseDir, destBaseDir) => {
  folders.forEach(folder => {
    const srcPath = path.join(srcBaseDir, folder);
    const destPath = path.join(destBaseDir, folder);
    if (fs.existsSync(srcPath)) copyAssets(srcPath, destPath);
  });
};

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

(async () => {
  await createTablesIfNotExist();

  const keys = await loadAllKeys();
  const translations = await loadAllTranslations();

  const languages = ['en', 'ko', 'zh', 'ar', 'pt', 'es', 'fr', 'de', 'ru'];
  await createTranslatedStrings(languages, translations);

  for (const lang of languages) {
    await processDirectoryForTranslations(srcDir, keys, translations, lang);
  }

  const topLevelFolders = ['videos', 'css', 'js', 'images', 'fonts', 'static'];
  copyTopLevelFolders(topLevelFolders, path.join(__dirname, 'src'), distDir);
  copyRootHtmlFiles(path.join(__dirname, 'src'), distDir);

  console.log('Build and translation complete.');
})();