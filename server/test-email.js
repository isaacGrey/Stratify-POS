
import 'dotenv/config';
import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    requireTLS: Number(process.env.SMTP_PORT) === 587,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

try {
    console.log('Testing SMTP connection...');

    await transporter.verify();

    console.log('SMTP connection successful!');
    console.log('Crema Coffee SaaS email service is ready.');
} catch (error) {
    console.error('SMTP connection failed:', error.message);
} finally {
    transporter.close();
}
