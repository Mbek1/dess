const axios = require('axios');

async function testLogin() {
  try {
    console.log('🧪 Testing login endpoint...\n');
    
    const response = await axios.post('http://localhost:3000/api/auth/login', {
      email: 'admin@example.com',
      password: 'admin123',
      role: 'admin'
    });

    console.log('✅ Login successful!\n');
    console.log('Response Status:', response.status);
    console.log('Response Data:');
    console.log(JSON.stringify(response.data, null, 2));
  } catch (err: any) {
    console.log('❌ Login failed!\n');
    console.log('Status:', err.response?.status);
    console.log('Error:', err.response?.data);
    console.log('\nFull Error:');
    console.log(err.message);
  }
}

testLogin();
