const express = require('express');
const serverless = require('serverless-http');
const app = express();
const router = express.Router();
require('dotenv').config();
const fetch = require('node-fetch'); // Remove if using Node 18+ native fetch
const cors = require('cors');
const fs = require('fs');
const math = require('mathjs');
const { parse } = require('csv-parse/sync');

app.use(cors());
app.use(express.json());

const csvUrl = 'https://searchapi09.netlify.app/products.csv';
const jsonUrl = 'https://searchapi09.netlify.app/embeddings.json';
const tmpJsonFilePath = '/tmp/embeddings.json';

let cachedProducts = null;
const embeddingCache = new Map();

// Load products from CSV
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
    throw error;
  }
}

// Load stored embeddings from URL or /tmp
async function loadEmbeddingsFromFile() {
  try {
    if (fs.existsSync(tmpJsonFilePath)) {
      const data = fs.readFileSync(tmpJsonFilePath, 'utf8');
      const embeddings = JSON.parse(data);
      embeddings.forEach(([text, embedding]) => embeddingCache.set(text, embedding));
      console.log(`Loaded ${embeddingCache.size} embeddings from ${tmpJsonFilePath}`);
      return;
    }

    const response = await fetch(jsonUrl);
    if (!response.ok) {
      console.log(`Embeddings URL not found or inaccessible (status: ${response.status}), starting fresh`);
      return;
    }
    const data = await response.json();
    data.forEach(([text, embedding]) => {
      if (Array.isArray(embedding) && embedding.length === 768) {
        embeddingCache.set(text, embedding);
      } else {
        console.warn(`Invalid embedding for "${text}": expected length 768, got ${embedding?.length || 'undefined'}`);
      }
    });
    console.log(`Loaded ${embeddingCache.size} embeddings from ${jsonUrl}`);
    fs.writeFileSync(tmpJsonFilePath, JSON.stringify(data));
  } catch (error) {
    console.error('Error loading embeddings:', error);
  }
}

// Save embeddings to /tmp
async function saveEmbeddingsToFile() {
  try {
    const data = JSON.stringify([...embeddingCache.entries()]);
    fs.writeFileSync(tmpJsonFilePath, data);
    console.log(`Embeddings saved to ${tmpJsonFilePath}`);
  } catch (error) {
    console.error('Error saving embeddings to /tmp:', error);
  }
}

// Get embedding from Ollama (with validation)
async function getOllamaEmbedding(text) {
  if (!text || typeof text !== 'string') return null;
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
    if (!Array.isArray(data.embedding) || data.embedding.length !== 768) {
      throw new Error(`Invalid embedding: expected length 768, got ${data.embedding?.length || 'undefined'}`);
    }

    embeddingCache.set(text, data.embedding);
    return data.embedding;
  } catch (error) {
    console.error(`Embedding error for "${text}":`, error.message);
    return null;
  }
}

// Preload all product embeddings at startup
let preloadedEmbeddings = false;
async function preloadEmbeddings() {
  if (preloadedEmbeddings) return;
  await loadEmbeddingsFromFile();
  const products = await loadProductsFromCSV();

  const embeddingsToFetch = [];
  for (const product of products) {
    const desc = product.DESCRIPTION || '';
    if (desc && !embeddingCache.has(desc)) {
      embeddingsToFetch.push(desc);
    }
  }

  console.log(`Preloading embeddings for ${embeddingsToFetch.length} products`);
  await Promise.all(
    embeddingsToFetch.map(async (desc) => {
      const embedding = await getOllamaEmbedding(desc);
      if (embedding) embeddingCache.set(desc, embedding);
    })
  );
  await saveEmbeddingsToFile();
  preloadedEmbeddings = true;
  console.log('Preloading complete');
}

// Calculate cosine similarity with validation
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
    console.warn(`Invalid vectors for cosine similarity: length a=${a?.length || 'undefined'}, b=${b?.length || 'undefined'}`);
    return 0;
  }
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
    const productEmbedding = embeddingCache.get(product.DESCRIPTION || '');
    if (productEmbedding && Array.isArray(productEmbedding) && productEmbedding.length === 768) {
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
    } else {
      console.warn(`Skipping product "${product.NAME || 'unknown'}": invalid or missing embedding`);
    }
  }

  return results.sort((a, b) => b.similarity - a.similarity).slice(0, 5);
}

// Initialize data at startup
preloadEmbeddings().catch((err) => console.error('Preload failed:', err));

// Search route
router.post('/search', async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== 'string') {
    return res.status(400).send('Valid query string is required.');
  }

  try {
    const queryEmbedding = await getOllamaEmbedding(query);
    if (!queryEmbedding || !Array.isArray(queryEmbedding) || queryEmbedding.length !== 768) {
      return res.status(500).send('Failed to generate valid query embedding');
    }
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
    jsonUrl: jsonUrl,
    tmpJsonFilePath: tmpJsonFilePath,
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