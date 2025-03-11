const express = require('express');
const serverless = require('serverless-http');
const app = express();
const router = express.Router();
require('dotenv').config();
const fetch = require('node-fetch');
const cors = require('cors');
const fs = require('fs');
const csv = require('fast-csv');
const path = require('path');
const math = require('mathjs');

app.use(cors());
app.use(express.json());
let records = [];

const csvFilePath = 'https://searchapi09.netlify.app/data/products.csv'; 
const jsonFilePath = path.join(__dirname, 'data', 'embeddings.json'); 

//Get all students
router.get('/', (req, res) => {
  res.json({
    message: csvFilePath,
    csvFilePath: csvFilePath,
    jsonFilePath: jsonFilePath
  });
});


let cachedProducts = null;
const embeddingCache = new Map();
const embeddingsFilePath = jsonFilePath;

// Load products from CSV (with caching)
async function loadProductsFromCSV() {
    if (cachedProducts) return cachedProducts;

    const products = [];
    const csvUrl = 'https://searchapi09.netlify.app/data/products.csv';  // Ensure the correct URL to your CSV file

    try {
      const stream = response.body.pipe(csv.parse({ headers: true, skipEmptyLines: true }));
        for await (const row of stream) {
            products.push(row);
        }
        cachedProducts = products;
        console.log(`Loaded ${products.length} products from ${csvPath}`);
        return cachedProducts;
    } catch (error) {
        console.error('Error reading CSV file:', error);
        throw new Error('Failed to load products.');
    }
}

// Load stored embeddings from the embeddings.json file (if exists)
async function loadEmbeddingsFromFile() {
    try {
        if (fs.existsSync(embeddingsFilePath)) {
            const data = fs.readFileSync(embeddingsFilePath, 'utf8');
            return JSON.parse(data); // Parse the JSON data from the file
        } else {
            return [];  // If the file doesn't exist, return an empty array
        }
    } catch (error) {
        console.error('Error loading embeddings from file:', error);
        return [];  // Return empty array if there's an error
    }
}

// Save embeddings to the embeddings.json file
async function saveEmbeddingsToFile() {
    try {
        const data = JSON.stringify([...embeddingCache.entries()]); // Convert Map to array and stringify
        fs.writeFileSync(embeddingsFilePath, data);  // Write to the embeddings.json file
        console.log('Embeddings saved to embeddings.json');
    } catch (error) {
        console.error('Error saving embeddings to file:', error);
    }
}

// Get embedding from Ollama (with caching and timeout)
async function getOllamaEmbedding(text) {
    if (embeddingCache.has(text)) {
        return embeddingCache.get(text);
    }

    const url = 'https://8b09-2001-1c04-4402-5000-3859-af10-769f-7dc8.ngrok-free.app/api/embeddings';
    const controller = new AbortController();
    // const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
            signal: controller.signal
        });

        // clearTimeout(timeoutId);

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
    const dotProduct = math.dot(a, b); // Dot product using math.js
    const magnitudeA = math.norm(a); // Magnitude of vector a
    const magnitudeB = math.norm(b); // Magnitude of vector b
    if (magnitudeA === 0 || magnitudeB === 0) return 0; // Avoid division by zero
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

            if (!isNaN(similarity)) { // Only include valid similarities
                results.push({
                    PRODUCT_ID: product.PRODUCT_ID,
                    NAME: product.NAME,
                    CREATEDBY: product.CREATEDBY,
                    DESCRIPTION: product.DESCRIPTION,
                    similarity
                });
            }
        } catch (error) {
            console.warn(`Skipping product "${product.NAME || 'unknown'}" due to error: ${error.message}`);
        }
    }

    return results
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 5); // Top 5 results
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




//Create new record
router.post('/add', (req, res) => {
  res.send('New record added.', csvFilePath, jsonFilePath);
});

//delete existing record
router.delete('/', (req, res) => {
  res.send('Deleted existing record');
});

//updating existing record
router.put('/', (req, res) => {
  res.send('Updating existing record');
});

//showing demo records
router.get('/demo', (req, res) => {
  res.json([
    {
      id: '001',
      name: 'Smith',
      email: 'smith@gmail.com',
    },
    {
      id: '002',
      name: 'Sam',
      email: 'sam@gmail.com',
    },
    {
      id: '003',
      name: 'lily',
      email: 'lily@gmail.com',
    },
  ]);
});

app.use('/.netlify/functions/api', router);
module.exports.handler = serverless(app);
