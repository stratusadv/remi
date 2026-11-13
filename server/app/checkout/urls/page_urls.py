from django.urls import path

from app.checkout.views import page_views


app_name = 'page'

urlpatterns = [
    path('return/', page_views.checkout_return_view, name='return'),
]
