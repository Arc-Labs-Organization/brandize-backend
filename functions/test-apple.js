const jwt = require('jsonwebtoken');
const axios = require('axios');

// BURAYI DOLDUR (Test amaçlı)
const P8_KEY = `-----BEGIN PRIVATE KEY-----
MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQgM/yuqa5jv4F0Q72x
n3gnOjf1qb7AA23tq0KQnc7h7pOgCgYIKoZIzj0DAQehRANCAATVCtJqCYev5pJ3
0ACfceykyyLh/6B3ieWvqBnAzo7Iwvjpfoer1HsVHElSJhFtS4vFFYtQ3oHWuG2o
dDI8t9kc
-----END PRIVATE KEY-----`;
const KEY_ID = '263DJMYURT';
const TEAM_ID = 'L2836963V8';

async function testConnection() {
    const iat = Math.floor(Date.now() / 1000);
    
    // 1. JWT Oluşturma Testi
    const token = jwt.sign({ iss: TEAM_ID, iat: iat }, P8_KEY, {
        algorithm: 'ES256',
        header: { alg: 'ES256', kid: KEY_ID }
    });

    console.log("✅ JWT Başarıyla Oluşturuldu:", token);

    // 2. Apple API Testi (Query)
    try {
        const res = await axios.post(
            'https://api.development.devicecheck.apple.com/v1/query_two_bits', // Test için development URL
            {
                device_token: "DUMMY_TOKEN", // Gerçek olmadığı için 400 hatası alabiliriz ama 401 almamalıyız
                transaction_id: "test-123",
                timestamp: Date.now()
            },
            { headers: { Authorization: `Bearer ${token}` } }
        );
        console.log("Apple Cevabı:", res.data);
    } catch (error) {
        if (error.response && error.response.status === 400) {
            console.log("✅ Tebrikler! 400 Bad Request aldın. Bu, Apple ile bağlantının kurulduğunu ama tokenın (DUMMY_TOKEN) geçersiz olduğunu gösterir. Yani anahtarın doğru!");
        } else {
            console.error("❌ Hata:", error.response ? error.response.status : error.message);
            console.log("Eğer 401 alıyorsan anahtarın veya ID'lerin yanlıştır.");
        }
    }
}

testConnection();