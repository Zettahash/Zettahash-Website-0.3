const fs = require('fs-extra');
const path = require('path');
const cheerio = require('cheerio');

// Directories
const srcDir = path.join(__dirname, 'src');
const distDir = path.join(__dirname, 'dist');

// Ensure dist directory exists
fs.ensureDirSync(distDir);

// Tags to look for strings to translate
const tagsToTranslate = ['div', 'p', 'span', 'li', 'th', 'td', 'b', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

// Load the English strings JSON if it exists, otherwise start with an empty object
const jsonFilePath = path.join(__dirname, 'consolidated_english_strings_with_keys.json');
let englishStrings = {};
if (fs.existsSync(jsonFilePath)) {
  englishStrings = require(jsonFilePath);
}

// Function to create unique keys based on the text
const createUniqueKey = (text) => {
  return text.replace(/\s+/g, '_').substring(0, 20);
};

// Function to process HTML files
const processHtmlFile = (filePath) => {
  const content = fs.readFileSync(filePath, 'utf8');
  const $ = cheerio.load(content);

  tagsToTranslate.forEach(tag => {
    $(tag).each((i, elem) => {
      const text = $(elem).text().trim();
      if (text) {
        let key = Object.keys(englishStrings).find(k => englishStrings[k] === text);
        if (!key) {
          key = createUniqueKey(text);
          englishStrings[key] = text;
        }
        $(elem).attr('data-string-key', key);
      }
    });
  });

  const newHtml = $.html();
  const outputFilePath = path.join(distDir, path.relative(srcDir, filePath));
  fs.ensureFileSync(outputFilePath);
  fs.writeFileSync(outputFilePath, newHtml, 'utf8');
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

// Function to process directories recursively
const processDirectory = (dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  entries.forEach(entry => {
    const fullPath = path.join(dir, entry.name);
    const outputPath = path.join(distDir, path.relative(srcDir, fullPath));

    if (entry.isDirectory()) {
      fs.ensureDirSync(outputPath);
      processDirectory(fullPath);
    } else if (entry.isFile() && path.extname(entry.name) === '.html') {
      processHtmlFile(fullPath);
    } else {
      fs.copySync(fullPath, outputPath);
    }
  });
};

// Read all files and process them
processDirectory(srcDir);

// Copy assets
copyAssets(srcDir, distDir);

// Write the strings JSON file
const outputJsonFilePath = path.join(distDir, 'strings.json');
fs.writeFileSync(outputJsonFilePath, JSON.stringify(englishStrings, null, 2), 'utf8');

console.log('Build complete.');