const express = require('express');
const serverless = require('serverless-http');
const app = express();
const router = express.Router();
require('dotenv').config();
const fetch = require('node-fetch'); // Remove if using Node 18+ (native fetch)
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const math = require('mathjs');
const { parse } = require('csv-parse/sync'); // Using csv-parse for Node.js

app.use(cors());
app.use(express.json());

const csvUrl = 'https://searchapi09.netlify.app/products.csv';
const jsonFilePath = path.join(__dirname, 'data', 'embeddings.json');

let cachedProducts = null;
const embeddingCache = new Map();
const embeddingsFilePath = jsonFilePath;

// Load products from CSV using fetch and csv-parse
async function loadProductsFromCSV() {
  if (cachedProducts) return cachedProducts;

  try {
    const response = await fetch(csvUrl);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const csvText = await response.text();
    const products = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
    });

    cachedProducts = products;
    console.log(`Loaded ${products.length} products from ${csvUrl}`);
    return products;
  } catch (error) {
    console.error('Error loading CSV file:', error);
    throw new Error('Failed to load products');
  }
}

// Load stored embeddings from the embeddings.json file (if exists)
async function loadEmbeddingsFromFile() {
  try {
    if (fs.existsSync(embeddingsFilePath)) {
      const data = fs.readFileSync(embeddingsFilePath, 'utf8');
      return JSON.parse(data);
    }
    return [];
  } catch (error) {
    console.error('Error loading embeddings from file:', error);
    return [];
  }
}

// Save embeddings to the embeddings.json file
async function saveEmbeddingsToFile() {
  try {
    const data = JSON.stringify([...embeddingCache.entries()]);
    fs.writeFileSync(embeddingsFilePath, data);
    console.log('Embeddings saved to embeddings.json');
  } catch (error) {
    console.error('Error saving embeddings to file:', error);
  }
}

// Get embedding from Ollama (with caching)
async function getOllamaEmbedding(text) {
  if (embeddingCache.has(text)) {
    return embeddingCache.get(text);
  }

  const url = 'https://8b09-2001-1c04-4402-5000-3859-af10-769f-7dc8.ngrok-free.app/api/embeddings';
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const data = await response.json();
    if (!data.embedding) {
      throw new Error('No embedding returned from Ollama');
    }

    embeddingCache.set(text, data.embedding);
    await saveEmbeddingsToFile();
    return data.embedding;
  } catch (error) {
    console.error(`Embedding error for "${text}":`, error.message);
    throw error;
  }
}

// Calculate cosine similarity using math.js
function cosineSimilarity(a, b) {
  const dotProduct = math.dot(a, b);
  const magnitudeA = math.norm(a);
  const magnitudeB = math.norm(b);
  if (magnitudeA === 0 || magnitudeB === 0) return 0;
  return dotProduct / (magnitudeA * magnitudeB);
}

// Search products based on query embedding
async function searchProducts(queryEmbedding) {
  const products = await loadProductsFromCSV();
  const results = [];

  for (const product of products) {
    try {
      const productEmbedding = await getOllamaEmbedding(product.DESCRIPTION || '');
      const similarity = cosineSimilarity(queryEmbedding, productEmbedding);

      if (!isNaN(similarity)) {
        results.push({
          PRODUCT_ID: product.PRODUCT_ID,
          NAME: product.NAME,
          CREATEDBY: product.CREATEDBY,
          DESCRIPTION: product.DESCRIPTION,
          similarity,
        });
      }
    } catch (error) {
      console.warn(`Skipping product "${product.NAME || 'unknown'}" due to error: ${error.message}`);
    }
  }

  return results.sort((a, b) => b.similarity - a.similarity).slice(0, 5);
}

// Search route
router.post('/search', async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== 'string') {
    return res.status(400).send('Valid query string is required.');
  }

  try {
    const queryEmbedding = await getOllamaEmbedding(query);
    const searchResults = await searchProducts(queryEmbedding);
    res.json(searchResults);
  } catch (error) {
    console.error('Search error:', error.message);
    res.status(500).send(`Search failed: ${error.message}`);
  }
});

// Root route
router.get('/', (req, res) => {
  res.json({
    message: 'API is running',
    csvUrl: csvUrl,
    jsonFilePath: jsonFilePath,
  });
});

// Demo route
router.get('/demo', (req, res) => {
  res.json([
    { id: '001', name: 'Smith', email: 'smith@gmail.com' },
    { id: '002', name: 'Sam', email: 'sam@gmail.com' },
    { id: '003', name: 'Lily', email: 'lily@gmail.com' },
  ]);
});

app.use('/.netlify/functions/api', router);
module.exports.handler = serverless(app);